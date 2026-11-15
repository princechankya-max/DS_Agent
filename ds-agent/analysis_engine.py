#!/usr/bin/env python3
"""
DS Agent — Analysis Engine
Generates: cleaned_data.csv, eda_report.md, insights_report.md,
           /visualizations/*.png, analysis_notebook.ipynb, result.json
"""
import sys
import json
import argparse
import warnings
import os
import re
import traceback
from pathlib import Path
from datetime import datetime

warnings.filterwarnings('ignore')

def progress(step, pct, msg):
    print(f"PROGRESS:{step}|{pct}|{msg}", flush=True)

def run_ml(df, target, out_dir, pd, np):
    if not target:
        return {'status': 'skipped', 'reason': 'Choose a target column to run machine learning.'}

    target_col = str(target).strip().lower().replace(' ', '_').replace('-', '_')
    if target_col not in df.columns:
        return {
            'status': 'skipped',
            'reason': f"Target column '{target}' was not found after cleaning. Available columns: {', '.join(map(str, df.columns))}",
        }

    from sklearn.compose import ColumnTransformer
    from sklearn.dummy import DummyClassifier, DummyRegressor
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import LogisticRegression, Ridge
    from sklearn.metrics import accuracy_score, f1_score, make_scorer, mean_squared_error, r2_score
    from sklearn.model_selection import KFold, StratifiedKFold, cross_validate, train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    modeling_data = df.dropna(subset=[target_col]).copy()
    if len(modeling_data) < 12:
        return {'status': 'skipped', 'reason': 'At least 12 rows with a target value are required for a train/test comparison.'}

    y = modeling_data[target_col]
    target_is_categorical = (
        pd.api.types.is_object_dtype(y.dtype)
        or pd.api.types.is_string_dtype(y.dtype)
        or pd.api.types.is_bool_dtype(y.dtype)
        or isinstance(y.dtype, pd.CategoricalDtype)
        or (pd.api.types.is_integer_dtype(y.dtype) and y.nunique() <= 20)
    )
    task = 'classification' if target_is_categorical else 'regression'
    class_count = int(y.nunique())

    if class_count < 2:
        return {'status': 'skipped', 'reason': 'The target column must contain at least two distinct values.'}
    if task == 'classification' and y.value_counts().min() < 2:
        return {'status': 'skipped', 'reason': 'Each target class needs at least two rows for a stratified train/test split.'}

    feature_columns = modeling_data.drop(columns=[target_col]).copy()
    date_columns = [
        column for column in feature_columns.columns
        if pd.api.types.is_datetime64_any_dtype(feature_columns[column].dtype)
    ]
    date_components = {
        'year': 'year',
        'month': 'month',
        'day': 'day',
        'dayofweek': 'day_of_week',
        'hour': 'hour',
    }
    for column in date_columns:
        values = feature_columns[column].dt
        for component, accessor in date_components.items():
            feature_columns[f'{column}__{component}'] = getattr(values, accessor).astype('float64')
        feature_columns = feature_columns.drop(columns=[column])

    numeric_features = feature_columns.select_dtypes(include=np.number).columns.tolist()
    categorical_features = [
        col for col in feature_columns.columns
        if (
            pd.api.types.is_object_dtype(feature_columns[col].dtype)
            or pd.api.types.is_string_dtype(feature_columns[col].dtype)
            or isinstance(feature_columns[col].dtype, pd.CategoricalDtype)
            or pd.api.types.is_bool_dtype(feature_columns[col].dtype)
        )
    ]

    supported_features = numeric_features + categorical_features
    if not supported_features:
        return {'status': 'skipped', 'reason': 'No supported numeric or categorical feature columns remain after excluding the target.'}

    if len(modeling_data) > 20000:
        if task == 'classification':
            try:
                sampled_indices, _ = train_test_split(
                    modeling_data.index,
                    train_size=20000,
                    random_state=42,
                    stratify=y,
                )
                modeling_data = modeling_data.loc[sampled_indices]
            except ValueError as exc:
                return {'status': 'skipped', 'reason': f'Unable to create a stratified model sample: {exc}'}
        else:
            modeling_data = modeling_data.sample(n=20000, random_state=42)
        feature_columns = feature_columns.loc[modeling_data.index]
        y = modeling_data[target_col]

    stratify = y if task == 'classification' else None
    try:
        x_train, x_test, y_train, y_test = train_test_split(
            feature_columns[supported_features],
            y,
            test_size=0.25,
            random_state=42,
            stratify=stratify,
        )
    except ValueError as exc:
        return {'status': 'skipped', 'reason': f'Unable to create a valid train/test split: {exc}'}

    high_cardinality = [
        col for col in categorical_features
        if x_train[col].nunique(dropna=True) > min(1000, max(100, int(len(x_train) * 0.8)))
    ]
    feature_count = len(numeric_features) + len(categorical_features) - len(high_cardinality)
    if feature_count == 0:
        return {'status': 'skipped', 'reason': 'No supported features remain after excluding high-cardinality columns.'}

    def make_preprocessor():
        transformers = []
        if numeric_features:
            transformers.append(('numeric', Pipeline([
                ('imputer', SimpleImputer(strategy='median', keep_empty_features=True)),
                ('scaler', StandardScaler()),
            ]), numeric_features))
        if categorical_features:
            def select_low_cardinality_categories(frame):
                threshold = min(1000, max(100, int(len(frame) * 0.8)))
                return [
                    column for column in categorical_features
                    if frame[column].nunique(dropna=True) <= threshold
                ]

            transformers.append(('categorical', Pipeline([
                ('imputer', SimpleImputer(strategy='most_frequent', keep_empty_features=True)),
                ('encoder', OneHotEncoder(handle_unknown='ignore')),
            ]), select_low_cardinality_categories))
        return ColumnTransformer(transformers, remainder='drop')

    if task == 'classification':
        min_class_count = int(y_train.value_counts().min())
        if min_class_count < 2:
            return {
                'status': 'skipped',
                'reason': 'At least two examples per class must remain in the training split for cross-validation.',
            }
        cv_folds = min(5, min_class_count)
        cross_validator = StratifiedKFold(n_splits=cv_folds, shuffle=True, random_state=42)
        scoring = {
            'f1_macro': make_scorer(f1_score, average='macro', pos_label=None, zero_division=0),
            'accuracy': 'accuracy',
        }
        candidates = [
            ('Logistic Regression', LogisticRegression(max_iter=1000, class_weight='balanced')),
            ('Random Forest', RandomForestClassifier(
                n_estimators=100,
                min_samples_leaf=2,
                class_weight='balanced_subsample',
                random_state=42,
                n_jobs=1,
            )),
            ('Most Frequent Baseline', DummyClassifier(strategy='most_frequent')),
        ]
        selection_metric = 'cv_f1_macro_mean'
        selection_direction = 'maximize'
    else:
        cv_folds = min(5, len(y_train))
        if cv_folds < 2:
            return {'status': 'skipped', 'reason': 'At least two training rows are required for cross-validation.'}
        cross_validator = KFold(n_splits=cv_folds, shuffle=True, random_state=42)
        scoring = {'rmse': 'neg_root_mean_squared_error'}
        candidates = [
            ('Ridge Regression', Ridge()),
            ('Random Forest', RandomForestRegressor(
                n_estimators=100,
                min_samples_leaf=2,
                random_state=42,
                n_jobs=1,
            )),
            ('Mean Baseline', DummyRegressor(strategy='mean')),
        ]
        selection_metric = 'cv_rmse_mean'
        selection_direction = 'minimize'

    model_results = []
    for model_name, estimator in candidates:
        try:
            model = Pipeline([
                ('preprocessor', make_preprocessor()),
                ('model', estimator),
            ])
            cv_result = cross_validate(
                model,
                x_train[supported_features],
                y_train,
                cv=cross_validator,
                scoring=scoring,
                error_score='raise',
                n_jobs=1,
            )
            model.fit(x_train, y_train)
            predictions = model.predict(x_test)
            if task == 'classification':
                metrics = {
                    'accuracy': round(float(accuracy_score(y_test, predictions)), 4),
                    'f1_macro': round(float(f1_score(y_test, predictions, average='macro', zero_division=0)), 4),
                }
                cv_metrics = {
                    'f1_macro_mean': round(float(np.mean(cv_result['test_f1_macro'])), 4),
                    'f1_macro_std': round(float(np.std(cv_result['test_f1_macro'])), 4),
                    'accuracy_mean': round(float(np.mean(cv_result['test_accuracy'])), 4),
                    'accuracy_std': round(float(np.std(cv_result['test_accuracy'])), 4),
                }
                score = cv_metrics['f1_macro_mean']
            else:
                metrics = {
                    'r2': round(float(r2_score(y_test, predictions)), 4),
                    'rmse': round(float(np.sqrt(mean_squared_error(y_test, predictions))), 4),
                }
                cv_metrics = {
                    'rmse_mean': round(float(-np.mean(cv_result['test_rmse'])), 4),
                    'rmse_std': round(float(np.std(cv_result['test_rmse'])), 4),
                }
                score = -cv_metrics['rmse_mean']
            model_results.append({
                'name': model_name,
                'metrics': metrics,
                'cv_metrics': cv_metrics,
                'score': score,
            })
        except (ValueError, TypeError) as exc:
            model_results.append({'name': model_name, 'error': str(exc)})

    successful_models = [model for model in model_results if 'score' in model]
    if not successful_models:
        errors = '; '.join(f"{model['name']}: {model['error']}" for model in model_results)
        return {'status': 'skipped', 'reason': f'No candidate model could be trained. {errors}'}

    best_model = (
        max(successful_models, key=lambda model: model['score'])
        if task == 'classification'
        else min(successful_models, key=lambda model: model['cv_metrics']['rmse_mean'])
    )
    result = {
        'status': 'completed',
        'task': task,
        'target': target_col,
        'selection_metric': selection_metric,
        'selection_direction': selection_direction,
        'cv_folds': cv_folds,
        'train_rows': int(len(x_train)),
        'test_rows': int(len(x_test)),
        'feature_count': feature_count,
        'engineered_date_features': [
            f'{column}__{component}'
            for column in date_columns
            for component in ('year', 'month', 'day', 'dayofweek', 'hour')
        ],
        'excluded_high_cardinality_features': high_cardinality,
        'best_model': best_model['name'],
        'best_score': (
            best_model['cv_metrics']['f1_macro_mean']
            if task == 'classification'
            else best_model['cv_metrics']['rmse_mean']
        ),
        'models': model_results,
    }

    lines = [
        '# Machine Learning Model Comparison',
        f"**Task:** {task.title()}  ",
        f"**Target:** `{target_col}`  ",
        f"**Best model:** {best_model['name']}  ",
        f"**Selection metric:** {selection_metric} ({selection_direction})  ",
        f"**Cross-validation folds:** {cv_folds}  ",
        f"**Train/test rows:** {len(x_train)}/{len(x_test)}  ",
        f"**Features used:** {len(supported_features)}",
        '',
        'Models are selected by cross-validation on the training split; final metrics use a separate 25% holdout. Imputation, scaling, and categorical encoding are fit inside each training fold only.',
        '',
        '| Model | Cross-validation metrics | Holdout metrics |',
        '|---|---|---|',
    ]
    for model in model_results:
        if 'metrics' in model:
            cv_detail = ', '.join(f'{key}: {value}' for key, value in model['cv_metrics'].items())
            holdout_detail = ', '.join(f'{key}: {value}' for key, value in model['metrics'].items())
            lines.append(f"| {model['name']} | {cv_detail} | {holdout_detail} |")
        else:
            lines.append(f"| {model['name']} | — | Skipped: {model['error']} |")
    if high_cardinality:
        lines += ['', f"Excluded high-cardinality features: {', '.join(map(str, high_cardinality))}."]
    if date_columns:
        lines += ['', f"Engineered date features from: {', '.join(map(str, date_columns))}."]

    with open(out_dir / 'ml_report.md', 'w', encoding='utf-8') as report:
        report.write('\n'.join(lines))
    return result

def load_dataset(file_path, pd, categorical_columns=None):
    extension = Path(file_path).suffix.lower()
    categorical_columns = categorical_columns if isinstance(categorical_columns, list) else []
    category_dtypes = {
        column: 'string'
        for column in categorical_columns
        if isinstance(column, str)
    }
    if extension == '.csv':
        try:
            return pd.read_csv(file_path, encoding='utf-8-sig', on_bad_lines='error', dtype=category_dtypes)
        except UnicodeDecodeError:
            return pd.read_csv(file_path, encoding='latin-1', on_bad_lines='error', dtype=category_dtypes)
    if extension in ('.xlsx', '.xls'):
        return pd.read_excel(file_path)
    if extension == '.json':
        return pd.read_json(file_path)
    if extension == '.parquet':
        return pd.read_parquet(file_path)
    raise ValueError(f'Unsupported file format: {extension or "no extension"}')

def execute_query_plan(file_path, plan, pd, np, categorical_columns=None):
    if not isinstance(plan, dict):
        raise ValueError('Query plan must be an object')

    frame = load_dataset(file_path, pd, categorical_columns)
    if not isinstance(categorical_columns, list):
        categorical_columns = []
    for column in categorical_columns:
        if isinstance(column, str) and column in frame.columns:
            frame[column] = frame[column].astype('string')
    operation = plan.get('operation')
    if operation not in ('describe', 'value_counts', 'group_aggregate', 'correlation'):
        raise ValueError('Unsupported query operation')

    def require_keys(allowed):
        if set(plan) - allowed:
            raise ValueError('Query plan contains unsupported fields')

    def require_column(name, numeric=None):
        if not isinstance(name, str) or name not in frame.columns:
            raise ValueError('Query plan references an unavailable column')
        is_numeric = pd.api.types.is_numeric_dtype(frame[name].dtype)
        if numeric is True and not is_numeric:
            raise ValueError('Query plan requires a numeric column')
        if numeric is False and is_numeric:
            raise ValueError('Query plan requires a categorical column')
        return frame[name]

    def json_value(value):
        if value is None or pd.isna(value):
            return None
        if isinstance(value, np.generic):
            value = value.item()
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            if not np.isfinite(value):
                return None
            return round(value, 4) if isinstance(value, float) else value
        if hasattr(value, 'isoformat'):
            return value.isoformat()
        return str(value)[:200]

    if operation == 'describe':
        require_keys({'operation', 'columns'})
        columns = plan.get('columns')
        if (
            not isinstance(columns, list) or
            not 1 <= len(columns) <= 10 or
            any(not isinstance(column, str) for column in columns) or
            len(set(columns)) != len(columns)
        ):
            raise ValueError('Describe query requires 1 to 10 unique columns')
        rows = []
        for column in columns:
            series = require_column(column, numeric=True)
            rows.append({
                'column': column,
                'count': int(series.count()),
                'mean': json_value(series.mean()),
                'median': json_value(series.median()),
                'std': json_value(series.std()),
                'min': json_value(series.min()),
                'max': json_value(series.max()),
            })
        return {'operation': operation, 'summary': f'Descriptive statistics for {len(rows)} numeric columns.', 'rows': rows}

    if operation == 'value_counts':
        require_keys({'operation', 'column', 'limit'})
        series = require_column(plan.get('column'))
        limit = plan.get('limit', 10)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
            raise ValueError('Value-count limit must be from 1 to 20')
        rows = [
            {'value': json_value(value), 'count': int(count)}
            for value, count in series.value_counts(dropna=False).head(limit).items()
        ]
        return {'operation': operation, 'summary': f'Top {len(rows)} values for {plan["column"]}.', 'rows': rows}

    if operation == 'group_aggregate':
        require_keys({'operation', 'group_by', 'measure', 'aggregation', 'filter', 'limit'})
        group_by = plan.get('group_by')
        group_series = require_column(group_by, numeric=False)
        aggregation = plan.get('aggregation')
        measure = plan.get('measure')
        limit = plan.get('limit', 10)
        if aggregation not in ('count', 'sum', 'mean', 'median', 'min', 'max'):
            raise ValueError('Unsupported aggregation')
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
            raise ValueError('Grouped query limit must be from 1 to 20')
        if aggregation == 'count':
            if measure is not None:
                require_column(measure)
        else:
            require_column(measure, numeric=True)

        filtered = frame
        condition = plan.get('filter')
        if condition is not None:
            if not isinstance(condition, dict) or set(condition) != {'column', 'operator', 'value'}:
                raise ValueError('Invalid query filter')
            column = condition['column']
            series = require_column(column)
            operator = condition['operator']
            value = condition['value']
            if value is None or isinstance(value, (dict, list)):
                raise ValueError('Invalid filter value')
            if operator in ('gt', 'gte', 'lt', 'lte'):
                if not pd.api.types.is_numeric_dtype(series.dtype) or not isinstance(value, (int, float)) or isinstance(value, bool):
                    raise ValueError('Numeric filters require a numeric column and value')
                filtered = frame.loc[{
                    'gt': series > value,
                    'gte': series >= value,
                    'lt': series < value,
                    'lte': series <= value,
                }[operator]]
            elif operator in ('eq', 'neq') and (
                (pd.api.types.is_numeric_dtype(series.dtype) and isinstance(value, (int, float)) and not isinstance(value, bool))
                or (not pd.api.types.is_numeric_dtype(series.dtype) and isinstance(value, (str, bool)))
            ):
                mask = series.eq(value) if operator == 'eq' else series.ne(value)
                filtered = frame.loc[mask]
            elif operator == 'contains' and isinstance(value, str) and not pd.api.types.is_numeric_dtype(series.dtype):
                mask = series.astype('string').str.contains(value, case=False, regex=False, na=False)
                filtered = frame.loc[mask]
            else:
                raise ValueError('Unsupported filter')

        if aggregation == 'count':
            grouped = filtered.groupby(group_by, dropna=False, observed=True).size().rename('count')
        else:
            grouped = filtered.groupby(group_by, dropna=False, observed=True)[measure].agg(aggregation).rename(aggregation)
        grouped = grouped.sort_values(ascending=False).head(limit)
        rows = [
            {'group': json_value(group), aggregation: json_value(value)}
            for group, value in grouped.items()
        ]
        return {
            'operation': operation,
            'summary': f'{aggregation.title()} of {measure or "rows"} by {group_by}, limited to {limit} groups.',
            'rows': rows,
        }

    require_keys({'operation', 'columns'})
    columns = plan.get('columns')
    if (
        not isinstance(columns, list) or
        not 2 <= len(columns) <= 8 or
        any(not isinstance(column, str) for column in columns) or
        len(set(columns)) != len(columns)
    ):
        raise ValueError('Correlation query requires 2 to 8 unique columns')
    for column in columns:
        require_column(column, numeric=True)
    corr = frame[columns].corr()
    rows = []
    for left_index, left in enumerate(columns):
        for right in columns[left_index + 1:]:
            rows.append({
                'column_a': left,
                'column_b': right,
                'correlation': json_value(corr.loc[left, right]),
            })
    return {'operation': operation, 'summary': f'Pairwise correlations for {len(columns)} numeric columns.', 'rows': rows}

def run_query(config_path):
    import numpy as np
    import pandas as pd

    with open(config_path, encoding='utf-8') as config_file:
        config = json.load(config_file)
    result = execute_query_plan(
        config['file_path'],
        config['plan'],
        pd,
        np,
        config.get('categorical_columns'),
    )
    print(json.dumps(result, ensure_ascii=False), flush=True)

def clean_dataset(df_raw, pd):
    df = df_raw.copy()
    clean_log = []

    original_columns = df.columns.tolist()
    used_columns = set()
    standardized_columns = []
    for index, column in enumerate(original_columns):
        base_name = str(column).strip().lower().replace(' ', '_').replace('-', '_')
        base_name = base_name or f'column_{index + 1}'
        name = base_name
        suffix = 2
        while name in used_columns:
            name = f'{base_name}_{suffix}'
            suffix += 1
        used_columns.add(name)
        standardized_columns.append(name)
    df.columns = standardized_columns
    raw_null_counts = {
        column: int(df_raw.iloc[:, index].isnull().sum())
        for index, column in enumerate(standardized_columns)
    }
    if standardized_columns != original_columns:
        clean_log.append(f'Standardized {len(df.columns)} column names')

    drop_cols = [column for column in df.columns if df[column].isnull().mean() > 0.70]
    if drop_cols:
        df = df.drop(columns=drop_cols)
        clean_log.append(f'Dropped {len(drop_cols)} high-null columns (>70%): {drop_cols}')
    if df.shape[1] == 0:
        raise ValueError('No usable columns remain after removing columns with more than 70% missing values')

    before_duplicates = len(df)
    df = df.drop_duplicates()
    if before_duplicates > len(df):
        clean_log.append(f'Removed {before_duplicates - len(df)} duplicate rows')

    df_ml = df.copy()
    numeric_columns = df.select_dtypes(include='number').columns.tolist()
    for column in numeric_columns:
        if df[column].isnull().any():
            fill_value = df[column].median()
            df[column] = df[column].fillna(fill_value)
            clean_log.append(f"Imputed '{column}' nulls with median ({fill_value:.2f})")

    non_numeric_columns = [column for column in df.columns if column not in numeric_columns]
    for column in non_numeric_columns:
        if df[column].isnull().any():
            modes = df[column].mode(dropna=True)
            fill_value = modes.iloc[0] if not modes.empty else 'Unknown'
            df[column] = df[column].fillna(fill_value)
            clean_log.append(f"Imputed '{column}' nulls with mode ('{fill_value}')")

    outlier_log = []
    for column in numeric_columns:
        first_quartile = df[column].quantile(0.25)
        third_quartile = df[column].quantile(0.75)
        interquartile_range = third_quartile - first_quartile
        lower = first_quartile - 1.5 * interquartile_range
        upper = third_quartile + 1.5 * interquartile_range
        outlier_count = ((df[column] < lower) | (df[column] > upper)).sum()
        if outlier_count > 0:
            df[column] = df[column].clip(lower, upper)
            outlier_log.append(f"'{column}': capped {outlier_count} outliers [{lower:.2f}, {upper:.2f}]")

    if outlier_log:
        clean_log.append(f'Outlier capping (IQR): {len(outlier_log)} columns')

    return df, df_ml, clean_log, outlier_log, drop_cols, raw_null_counts

def categorical_columns(frame):
    return frame.select_dtypes(include=['object', 'string', 'category', 'bool']).columns.tolist()

def run(config_path):
    with open(config_path, encoding='utf-8') as f:
        cfg = json.load(f)

    job_id   = cfg['job_id']
    file_path= cfg['file_path']
    out_dir  = Path(cfg['output_dir'])
    target   = cfg.get('target_col')
    a_type   = cfg.get('analysis_type', 'eda')

    out_dir.mkdir(parents=True, exist_ok=True)
    viz_dir = out_dir / 'visualizations'
    viz_dir.mkdir(exist_ok=True)

    try:
        import pandas as pd
        import numpy as np
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        import seaborn as sns

        def finite_number(value, digits):
            number = float(value)
            return round(number, digits) if np.isfinite(number) else None

        # Dark theme for all plots
        plt.style.use('dark_background')
        DARK_BG  = '#05060F'
        CARD_BG  = '#0E1020'
        PRIMARY  = '#8B7CF8'
        TEAL     = '#5ECFB2'
        AMBER    = '#F5C97A'
        CORAL    = '#FF5370'
        MUTED    = '#8891AA'
        PALETTE  = [PRIMARY, TEAL, AMBER, CORAL, '#F5A8C8', '#22D3EE', '#F97316', '#A3E635']

        def save_fig(name):
            path = str(viz_dir / f'{name}.png')
            plt.savefig(path, dpi=150, bbox_inches='tight', facecolor=DARK_BG, edgecolor='none')
            plt.close()
            return Path(path).relative_to(out_dir).as_posix()

        # ── STEP 1: LOAD ──────────────────────────────
        progress('loading', 5, 'Loading dataset...')
        ext = Path(file_path).suffix.lower()
        df_raw = load_dataset(file_path, pd)

        if df_raw.empty:
            raise ValueError('The uploaded dataset has no rows')

        shape_before = df_raw.shape
        print(f"Loaded: {shape_before}", flush=True)

        # ── STEP 2: PROFILE ───────────────────────────
        progress('profiling', 15, 'Profiling data...')
        null_counts  = df_raw.isnull().sum()
        null_pcts    = (null_counts / len(df_raw) * 100).round(2)
        dup_count    = df_raw.duplicated().sum()
        mem_usage    = df_raw.memory_usage(deep=True).sum() / 1024 / 1024

        num_cols = df_raw.select_dtypes(include=np.number).columns.tolist()
        cat_cols = categorical_columns(df_raw)
        dat_cols = df_raw.select_dtypes(include=['datetime64']).columns.tolist()

        # ── STEP 3: CLEAN ─────────────────────────────
        progress('cleaning', 25, 'Cleaning data...')
        df, df_ml, clean_log, outlier_log, drop_cols, raw_null_counts = clean_dataset(df_raw, pd)

        shape_after = df.shape
        clean_log.insert(0, f"Shape: {shape_before} → {shape_after}")

        # Save cleaned data
        cleaned_path = str(out_dir / 'cleaned_data.csv')
        df.to_csv(cleaned_path, index=False)
        clean_log.append(f"Saved cleaned_data.csv ({shape_after[0]} rows × {shape_after[1]} cols)")

        # ── STEP 4: EDA STATS ─────────────────────────
        progress('eda', 40, 'Running EDA...')
        num_cols_c = df.select_dtypes(include=np.number).columns.tolist()
        cat_cols_c = categorical_columns(df)

        stats = {}
        for col in num_cols_c:
            s = df[col].describe()
            skew = finite_number(df[col].skew(), 3)
            kurt = finite_number(df[col].kurtosis(), 3)
            stats[col] = {
                'type': 'numeric', 'count': int(s['count']),
                'mean': finite_number(s['mean'], 4), 'std': finite_number(s['std'], 4),
                'min': finite_number(s['min'], 4), 'max': finite_number(s['max'], 4),
                'q1': finite_number(s['25%'], 4), 'median': finite_number(s['50%'], 4),
                'q3': finite_number(s['75%'], 4), 'skewness': skew,
                'kurtosis': kurt,
                'null_count': raw_null_counts[col],
            }

        for col in cat_cols_c:
            vc = df[col].value_counts()
            stats[col] = {
                'type': 'categorical', 'count': int(df[col].count()),
                'unique': int(df[col].nunique()),
                'mode': str(vc.index[0]) if len(vc) else 'N/A',
                'top_values': {str(k): int(v) for k, v in vc.head(10).items()},
                'null_count': raw_null_counts[col],
            }

        # ── STEP 5: VISUALIZATIONS ────────────────────
        progress('visualizations', 55, 'Generating charts...')
        viz_paths = []

        # 1. Distribution plots for numeric columns
        for i, col in enumerate(num_cols_c[:8]):
            fig, axes = plt.subplots(1, 2, figsize=(12, 4), facecolor=DARK_BG)
            for ax in axes: ax.set_facecolor(CARD_BG)

            axes[0].hist(df[col].dropna(), bins=30, color=PALETTE[i % len(PALETTE)], alpha=0.8, edgecolor='none')
            axes[0].set_title(f'Distribution: {col}', color='white', fontsize=12, fontweight='bold')
            axes[0].set_xlabel(col, color=MUTED); axes[0].set_ylabel('Count', color=MUTED)
            axes[0].tick_params(colors=MUTED)

            axes[1].boxplot(df[col].dropna(), patch_artist=True,
                boxprops=dict(facecolor=PALETTE[i % len(PALETTE)], color='white', alpha=0.7),
                medianprops=dict(color=AMBER, linewidth=2),
                whiskerprops=dict(color=MUTED), capprops=dict(color=MUTED),
                flierprops=dict(marker='o', color=CORAL, alpha=0.5))
            axes[1].set_title(f'Boxplot: {col}', color='white', fontsize=12, fontweight='bold')
            axes[1].tick_params(colors=MUTED)

            plt.tight_layout(pad=1.5)
            safe_col = re.sub(r'[^A-Za-z0-9._-]+', '_', str(col)).strip('._') or 'column'
            p = save_fig(f'dist_{i}_{safe_col}')
            viz_paths.append({'name': f'Distribution: {col}', 'path': p, 'type': 'distribution'})

        # 2. Categorical count plots
        for i, col in enumerate(cat_cols_c[:5]):
            if df[col].nunique() > 20: continue
            fig, ax = plt.subplots(figsize=(10, 5), facecolor=DARK_BG)
            ax.set_facecolor(CARD_BG)
            vc = df[col].value_counts().head(12)
            colors = [PALETTE[j % len(PALETTE)] for j in range(len(vc))]
            bars = ax.barh(vc.index.astype(str), vc.values, color=colors, alpha=0.85)
            ax.set_title(f'Value Counts: {col}', color='white', fontsize=13, fontweight='bold')
            ax.set_xlabel('Count', color=MUTED)
            ax.tick_params(colors=MUTED)
            for bar, val in zip(bars, vc.values):
                ax.text(val + 0.5, bar.get_y() + bar.get_height()/2, str(val), va='center', color=MUTED, fontsize=9)
            plt.tight_layout()
            safe_col = re.sub(r'[^A-Za-z0-9._-]+', '_', str(col)).strip('._') or 'column'
            p = save_fig(f'catcount_{i}_{safe_col}')
            viz_paths.append({'name': f'Value Counts: {col}', 'path': p, 'type': 'categorical'})

        # 3. Correlation Heatmap
        if len(num_cols_c) >= 2:
            corr = df[num_cols_c].corr()
            fig, ax = plt.subplots(figsize=(max(8, len(num_cols_c)), max(6, len(num_cols_c)-1)), facecolor=DARK_BG)
            ax.set_facecolor(CARD_BG)
            mask = np.triu(np.ones_like(corr, dtype=bool))
            cmap = sns.diverging_palette(267, 164, as_cmap=True)
            sns.heatmap(corr, mask=mask, ax=ax, cmap=cmap, vmin=-1, vmax=1,
                annot=True, fmt='.2f', annot_kws={'size': 9, 'color': 'white'},
                linewidths=0.5, linecolor='#1a1a2e',
                cbar_kws={'shrink': 0.8})
            ax.set_title('Correlation Matrix', color='white', fontsize=14, fontweight='bold', pad=16)
            ax.tick_params(colors=MUTED, labelsize=9)
            plt.tight_layout()
            p = save_fig('correlation_heatmap')
            viz_paths.append({'name': 'Correlation Heatmap', 'path': p, 'type': 'correlation'})

        # 4. Missing Values Heatmap
        null_df = df_raw.isnull()
        if null_df.any().any():
            fig, ax = plt.subplots(figsize=(max(10, len(df.columns)), 5), facecolor=DARK_BG)
            ax.set_facecolor(CARD_BG)
            null_pct = (df_raw.isnull().sum() / len(df_raw) * 100).sort_values(ascending=False)
            bars = ax.bar(null_pct.index, null_pct.values, color=[CORAL if v > 20 else AMBER if v > 5 else TEAL for v in null_pct.values], alpha=0.85)
            ax.set_title('Missing Values by Column (%)', color='white', fontsize=13, fontweight='bold')
            ax.set_ylabel('Null %', color=MUTED)
            ax.tick_params(colors=MUTED, axis='x', rotation=45)
            ax.tick_params(colors=MUTED, axis='y')
            plt.tight_layout()
            p = save_fig('missing_values')
            viz_paths.append({'name': 'Missing Values', 'path': p, 'type': 'quality'})

        # 5. Pairplot (top 4 correlated numeric cols)
        if len(num_cols_c) >= 3:
            top_corr_cols = num_cols_c[:min(4, len(num_cols_c))]
            try:
                pairplot_df = df[top_corr_cols].dropna()
                if len(pairplot_df) < 2:
                    raise ValueError('Not enough complete rows for a pairplot')
                g = sns.pairplot(pairplot_df.sample(min(500, len(pairplot_df))),
                    plot_kws={'alpha': 0.5, 'color': PRIMARY, 's': 15},
                    diag_kws={'color': TEAL, 'alpha': 0.7})
                g.fig.patch.set_facecolor(DARK_BG)
                for ax in g.axes.flatten():
                    if ax: ax.set_facecolor(CARD_BG)
                g.fig.suptitle('Pairplot — Top Numeric Features', color='white', y=1.02, fontsize=12, fontweight='bold')
                pairplot_path = viz_dir / 'pairplot.png'
                g.savefig(pairplot_path, dpi=120, bbox_inches='tight', facecolor=DARK_BG)
                plt.close()
                viz_paths.append({'name': 'Pairplot', 'path': pairplot_path.relative_to(out_dir).as_posix(), 'type': 'correlation'})
            except Exception as exc:
                print(f"WARNING: Pairplot was not generated: {exc}", file=sys.stderr, flush=True)

        # ── STEP 6: REPORTS ───────────────────────────
        # Data quality score
        null_score    = max(0, 100 - null_pcts.mean() * 2)
        outlier_score = 90 if not outlier_log else max(60, 90 - len(outlier_log)*3)
        dup_score     = 100 if dup_count == 0 else max(70, 100 - dup_count/len(df_raw)*100)
        quality_score = round((null_score + outlier_score + dup_score) / 3)

        # EDA Report
        eda_lines = [
            f"# 📊 EDA Report — {Path(cfg['file_path']).name}",
            f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} | **DS Agent v1.0**\n",
            "---\n",
            "## 📐 Dataset Overview",
            f"| Metric | Before | After Cleaning |",
            f"|---|---|---|",
            f"| Rows | {shape_before[0]:,} | {shape_after[0]:,} |",
            f"| Columns | {shape_before[1]} | {shape_after[1]} |",
            f"| Numeric Cols | {len(num_cols)} | {len(num_cols_c)} |",
            f"| Categorical Cols | {len(cat_cols)} | {len(cat_cols_c)} |",
            f"| Duplicate Rows | {dup_count} | 0 |",
            f"| Memory Usage | {mem_usage:.2f} MB | — |",
            f"\n**Data Quality Score: {quality_score}/100**\n",
            "---\n",
            "## 🧹 Cleaning Log",
        ]
        for log in clean_log:
            eda_lines.append(f"- {log}")
        eda_lines.append("\n---\n")
        eda_lines.append("## 📈 Numeric Column Statistics\n")
        eda_lines.append("| Column | Mean | Std | Min | Max | Median | Skewness | Kurtosis |")
        eda_lines.append("|---|---|---|---|---|---|---|---|")
        for col in num_cols_c:
            s = stats[col]
            eda_lines.append(f"| {col} | {s['mean']} | {s['std']} | {s['min']} | {s['max']} | {s['median']} | {s['skewness']} | {s['kurtosis']} |")

        eda_lines.append("\n---\n")
        eda_lines.append("## 🏷️ Categorical Column Summary\n")
        for col in cat_cols_c[:10]:
            s = stats[col]
            eda_lines.append(f"### {col}")
            eda_lines.append(f"- Unique values: {s['unique']} | Mode: `{s['mode']}` | Nulls: {s['null_count']}")
            eda_lines.append(f"- Top 5: {dict(list(s['top_values'].items())[:5])}\n")

        eda_path = str(out_dir / 'eda_report.md')
        with open(eda_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(eda_lines))

        # Insights Report
        insights = []
        for col in num_cols_c:
            s = stats[col]
            if s['skewness'] is not None and abs(s['skewness']) > 1:
                direction = 'right' if s['skewness'] > 0 else 'left'
                insights.append(f"**{col}** is {direction}-skewed (skewness={s['skewness']}). Consider log transformation for ML modeling.")
            if s['std'] is not None and s['mean'] is not None and s['std'] / max(abs(s['mean']), 1e-9) > 2:
                insights.append(f"**{col}** has high coefficient of variation — highly dispersed data. Normalization recommended.")

        for col in cat_cols_c:
            s = stats[col]
            if s['unique'] > len(df) * 0.9:
                insights.append(f"**{col}** has very high cardinality ({s['unique']} unique). May be an ID column — consider dropping for ML.")

        # Correlation insights
        if len(num_cols_c) >= 2:
            corr_m = df[num_cols_c].corr().abs()
            upper_corr = corr_m.where(np.triu(np.ones(corr_m.shape, dtype=bool), k=1))
            top = upper_corr.stack().sort_values(ascending=False).head(3)
            for (c1, c2), v in top.items():
                if v > 0.7:
                    insights.append(f"**{c1}** & **{c2}** are highly correlated (r={v:.2f}). Watch for multicollinearity in regression models.")

        ml_result = {'status': 'not_requested'}
        if a_type in ('eda_ml', 'full'):
            progress('machine_learning', 72, 'Training and comparing baseline models...')
            ml_result = run_ml(df_ml, target, out_dir, pd, np)
        progress('reports', 80, 'Writing reports...')

        ins_lines = [
            f"# 💡 Insights Report — {Path(cfg['file_path']).name}",
            f"**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n",
            "---\n",
            f"## 🎯 Data Quality Score: {quality_score}/100\n",
            f"| Check | Score |",
            f"|---|---|",
            f"| Null Values | {null_score:.0f}/100 |",
            f"| Outliers | {outlier_score}/100 |",
            f"| Duplicates | {dup_score:.0f}/100 |\n",
            "---\n",
            "## 🔍 Key Findings\n",
        ]
        if insights:
            for i, ins in enumerate(insights, 1):
                ins_lines.append(f"{i}. {ins}\n")
        else:
            ins_lines.append("- Data looks clean with no major anomalies detected.\n")

        ins_lines += [
            "---\n",
            "## 🚀 Recommendations\n",
            f"1. **Preprocessing:** {len(drop_cols)} columns with >70% nulls were dropped. Review if these contained business-critical info.",
            f"2. **Outliers:** {len(outlier_log)} numeric columns had outliers capped using IQR method.",
            "3. **Feature Engineering:** Consider creating interaction features between highly correlated columns.",
            (
                f"4. **Machine Learning:** Best {ml_result['task']} baseline for `{ml_result['target']}` was "
                f"{ml_result['best_model']} ({ml_result['selection_metric']}={ml_result['best_score']})."
                if ml_result['status'] == 'completed'
                else (
                    f"4. **Machine Learning:** {ml_result['reason']}"
                    if ml_result['status'] == 'skipped'
                    else "4. **Next Steps:** Select EDA + ML and a target column to compare baseline models."
                )
            ),
        ]

        ins_path = str(out_dir / 'insights_report.md')
        with open(ins_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(ins_lines))

        # ── STEP 7: NOTEBOOK ──────────────────────────
        progress('notebook', 90, 'Generating notebook...')
        try:
            import nbformat as nbf
            nb = nbf.v4.new_notebook()
            loader = {
                '.csv': 'read_csv',
                '.xlsx': 'read_excel',
                '.xls': 'read_excel',
                '.json': 'read_json',
                '.parquet': 'read_parquet',
            }[ext]
            cells = [
                nbf.v4.new_markdown_cell(f"# DS Agent Analysis — {Path(cfg['file_path']).name}\n*Generated by DS Agent v1.0*"),
                nbf.v4.new_code_cell("import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\nimport seaborn as sns\nplt.style.use('dark_background')\nprint('Libraries loaded ✓')"),
                nbf.v4.new_code_cell(f"df_raw = pd.{loader}({json.dumps(str(file_path))})\nprint(f'Shape: {{df_raw.shape}}')\ndf_raw.head()"),
                nbf.v4.new_markdown_cell("## 🧹 Data Cleaning"),
                nbf.v4.new_code_cell("df = df_raw.copy()\ndf.columns = [str(c).strip().lower().replace(' ','_').replace('-','_') for c in df.columns]\ndf.drop_duplicates(inplace=True)\ndf.fillna(df.median(numeric_only=True), inplace=True)\nprint('Cleaned shape:', df.shape)"),
                nbf.v4.new_markdown_cell("## 📊 EDA"),
                nbf.v4.new_code_cell("df.describe()"),
                nbf.v4.new_code_cell("num_cols = df.select_dtypes(include='number').columns\ndf[num_cols].hist(bins=20, figsize=(14,8), color='#8B7CF8', alpha=0.8)\nplt.tight_layout()\nplt.show()"),
                nbf.v4.new_code_cell("plt.figure(figsize=(10,7))\ncorr = df[num_cols].corr()\nsns.heatmap(corr, annot=True, fmt='.2f', cmap='coolwarm')\nplt.title('Correlation Matrix')\nplt.show()"),
                nbf.v4.new_markdown_cell("## 💡 Key Stats"),
                nbf.v4.new_code_cell("print('Null counts:')\nprint(df.isnull().sum())\nprint('\\nDtype summary:')\nprint(df.dtypes.value_counts())"),
            ]
            if ml_result['status'] == 'completed':
                cells.extend([
                    nbf.v4.new_markdown_cell("## 🤖 Machine Learning Baselines"),
                    nbf.v4.new_code_cell(
                        f"from sklearn.model_selection import train_test_split\n"
                        f"from sklearn.compose import ColumnTransformer\n"
                        f"from sklearn.impute import SimpleImputer\n"
                        f"from sklearn.pipeline import Pipeline\n"
                        f"from sklearn.preprocessing import OneHotEncoder, StandardScaler\n"
                        f"from sklearn.linear_model import LogisticRegression, Ridge\n"
                        f"from sklearn.dummy import DummyClassifier, DummyRegressor\n"
                        f"from sklearn.metrics import accuracy_score, f1_score, mean_squared_error, r2_score\n"
                        f"target = {json.dumps(ml_result['target'])}\n"
                        f"task = {json.dumps(ml_result['task'])}\n"
                        "model_data = df_raw.copy()\n"
                        "model_data.columns = [str(c).strip().lower().replace(' ', '_').replace('-', '_') for c in model_data.columns]\n"
                        "model_data.drop_duplicates(inplace=True)\n"
                        "model_data.drop(columns=[col for col in model_data.columns if model_data[col].isna().mean() > 0.70], inplace=True, errors='ignore')\n"
                        "model_data.dropna(subset=[target], inplace=True)\n"
                        "X = model_data.drop(columns=[target])\ny = model_data[target]\n"
                        "numeric = X.select_dtypes(include='number').columns.tolist()\n"
                        "categorical = [col for col in X.columns if pd.api.types.is_object_dtype(X[col].dtype) or pd.api.types.is_string_dtype(X[col].dtype) or isinstance(X[col].dtype, pd.CategoricalDtype) or pd.api.types.is_bool_dtype(X[col].dtype)]\n"
                        "transformers = []\n"
                        "if numeric:\n"
                        "    transformers.append(('numeric', Pipeline([('imputer', SimpleImputer(strategy='median', keep_empty_features=True)), ('scaler', StandardScaler())]), numeric))\n"
                        "if categorical:\n"
                        "    transformers.append(('categorical', Pipeline([('imputer', SimpleImputer(strategy='most_frequent', keep_empty_features=True)), ('encoder', OneHotEncoder(handle_unknown='ignore'))]), categorical))\n"
                        "preprocessor = ColumnTransformer(transformers)\n"
                        "stratify = y if task == 'classification' else None\n"
                        "X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, random_state=42, stratify=stratify)\n"
                        "models = [('Logistic Regression', LogisticRegression(max_iter=1000, class_weight='balanced')), ('Most Frequent Baseline', DummyClassifier(strategy='most_frequent'))] if task == 'classification' else [('Ridge Regression', Ridge()), ('Mean Baseline', DummyRegressor(strategy='mean'))]\n"
                        "for name, estimator in models:\n"
                        "    model = Pipeline([('preprocessor', preprocessor), ('model', estimator)])\n"
                        "    model.fit(X_train, y_train)\n"
                        "    predictions = model.predict(X_test)\n"
                        "    if task == 'classification':\n"
                        "        print(name, {'accuracy': accuracy_score(y_test, predictions), 'f1_macro': f1_score(y_test, predictions, average='macro', zero_division=0)})\n"
                        "    else:\n"
                        "        print(name, {'r2': r2_score(y_test, predictions), 'rmse': mean_squared_error(y_test, predictions) ** 0.5})\n"
                        f"print('Best model in DS Agent run: {ml_result['best_model']}')"
                    ),
                ])
            nb.cells = cells
            nb_path = str(out_dir / 'analysis_notebook.ipynb')
            with open(nb_path, 'w', encoding='utf-8') as f:
                nbf.write(nb, f)
        except ImportError:
            nb_path = None

        # ── STEP 8: RESULT JSON ───────────────────────
        progress('finalizing', 98, 'Finalizing...')
        result = {
            'job_id': job_id,
            'status': 'completed',
            'completed_at': datetime.now().isoformat(),
            'shape_before': list(shape_before),
            'shape_after': list(shape_after),
            'quality_score': quality_score,
            'num_cols': num_cols_c,
            'cat_cols': cat_cols_c,
            'stats': stats,
            'clean_log': clean_log,
            'outlier_log': outlier_log,
            'insights': insights,
            'files': {
                'cleaned_data': Path(cleaned_path).name,
                'eda_report': Path(eda_path).name,
                'insights_report': Path(ins_path).name,
                'notebook': Path(nb_path).name if nb_path else None,
                'ml_report': 'ml_report.md' if ml_result['status'] == 'completed' else None,
                'visualizations': [v['path'] for v in viz_paths],
            },
            'ml': ml_result,
            'viz_info': viz_paths,
        }

        result_path = str(out_dir / 'result.json')
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, default=str)

        progress('complete', 100, f'Done! {len(viz_paths)} charts, quality score {quality_score}/100')
        print(f"SUCCESS:{result_path}", flush=True)

    except Exception as e:
        err = traceback.format_exc()
        print(f"ERROR:{e}", flush=True, file=sys.stderr)
        print(err, file=sys.stderr)
        result = {'job_id': job_id, 'status': 'failed', 'error': str(e)}
        with open(str(out_dir / 'result.json'), 'w', encoding='utf-8') as f:
            json.dump(result, f)
        sys.exit(1)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--config')
    mode.add_argument('--query-config')
    args = parser.parse_args()
    if args.config:
        run(args.config)
    else:
        run_query(args.query_config)
