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
import traceback
from pathlib import Path
from datetime import datetime

warnings.filterwarnings('ignore')

def progress(step, pct, msg):
    print(f"PROGRESS:{step}|{pct}|{msg}", flush=True)

def run(config_path):
    with open(config_path) as f:
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
            return path

        # ── STEP 1: LOAD ──────────────────────────────
        progress('loading', 5, 'Loading dataset...')
        ext = Path(file_path).suffix.lower()
        if ext == '.csv':
            df_raw = pd.read_csv(file_path, encoding='utf-8', on_bad_lines='skip')
        elif ext in ['.xlsx', '.xls']:
            df_raw = pd.read_excel(file_path)
        elif ext == '.json':
            df_raw = pd.read_json(file_path)
        elif ext == '.parquet':
            df_raw = pd.read_parquet(file_path)
        else:
            df_raw = pd.read_csv(file_path, encoding='latin-1', on_bad_lines='skip')

        shape_before = df_raw.shape
        print(f"Loaded: {shape_before}", flush=True)

        # ── STEP 2: PROFILE ───────────────────────────
        progress('profiling', 15, 'Profiling data...')
        null_counts  = df_raw.isnull().sum()
        null_pcts    = (null_counts / len(df_raw) * 100).round(2)
        dup_count    = df_raw.duplicated().sum()
        mem_usage    = df_raw.memory_usage(deep=True).sum() / 1024 / 1024

        num_cols = df_raw.select_dtypes(include=np.number).columns.tolist()
        cat_cols = df_raw.select_dtypes(include='object').columns.tolist()
        dat_cols = df_raw.select_dtypes(include=['datetime64']).columns.tolist()

        # ── STEP 3: CLEAN ─────────────────────────────
        progress('cleaning', 25, 'Cleaning data...')
        df = df_raw.copy()
        clean_log = []

        # Standardize column names
        old_cols = df.columns.tolist()
        df.columns = [c.strip().lower().replace(' ', '_').replace('-', '_') for c in df.columns]
        if df.columns.tolist() != old_cols:
            clean_log.append(f"Standardized {len(df.columns)} column names")

        # Drop high-null columns (>70%)
        drop_cols = [c for c in df.columns if df[c].isnull().sum()/len(df) > 0.70]
        if drop_cols:
            df.drop(columns=drop_cols, inplace=True)
            clean_log.append(f"Dropped {len(drop_cols)} high-null columns (>70%): {drop_cols}")

        # Remove duplicates
        before_dup = len(df)
        df.drop_duplicates(inplace=True)
        if before_dup > len(df):
            clean_log.append(f"Removed {before_dup - len(df)} duplicate rows")

        # Impute missing values
        num_cols_c = df.select_dtypes(include=np.number).columns.tolist()
        cat_cols_c = df.select_dtypes(include='object').columns.tolist()

        for col in num_cols_c:
            if df[col].isnull().any():
                fill_val = df[col].median()
                df[col].fillna(fill_val, inplace=True)
                clean_log.append(f"Imputed '{col}' nulls with median ({fill_val:.2f})")

        for col in cat_cols_c:
            if df[col].isnull().any():
                fill_val = df[col].mode()[0] if len(df[col].mode()) else 'Unknown'
                df[col].fillna(fill_val, inplace=True)
                clean_log.append(f"Imputed '{col}' nulls with mode ('{fill_val}')")

        # Cap outliers (IQR)
        outlier_log = []
        for col in num_cols_c:
            Q1 = df[col].quantile(0.25)
            Q3 = df[col].quantile(0.75)
            IQR = Q3 - Q1
            lower, upper = Q1 - 1.5*IQR, Q3 + 1.5*IQR
            out_count = ((df[col] < lower) | (df[col] > upper)).sum()
            if out_count > 0:
                df[col] = df[col].clip(lower, upper)
                outlier_log.append(f"'{col}': capped {out_count} outliers [{lower:.2f}, {upper:.2f}]")

        if outlier_log:
            clean_log.append(f"Outlier capping (IQR): {len(outlier_log)} columns")

        shape_after = df.shape
        clean_log.insert(0, f"Shape: {shape_before} → {shape_after}")

        # Save cleaned data
        cleaned_path = str(out_dir / 'cleaned_data.csv')
        df.to_csv(cleaned_path, index=False)
        clean_log.append(f"Saved cleaned_data.csv ({shape_after[0]} rows × {shape_after[1]} cols)")

        # ── STEP 4: EDA STATS ─────────────────────────
        progress('eda', 40, 'Running EDA...')
        num_cols_c = df.select_dtypes(include=np.number).columns.tolist()
        cat_cols_c = df.select_dtypes(include='object').columns.tolist()

        stats = {}
        for col in num_cols_c:
            s = df[col].describe()
            skew = float(df[col].skew())
            kurt = float(df[col].kurtosis())
            stats[col] = {
                'type': 'numeric', 'count': int(s['count']),
                'mean': round(float(s['mean']), 4), 'std': round(float(s['std']), 4),
                'min': round(float(s['min']), 4), 'max': round(float(s['max']), 4),
                'q1': round(float(s['25%']), 4), 'median': round(float(s['50%']), 4),
                'q3': round(float(s['75%']), 4), 'skewness': round(skew, 3),
                'kurtosis': round(kurt, 3),
                'null_count': int(df[col].isnull().sum()),
            }

        for col in cat_cols_c:
            vc = df[col].value_counts()
            stats[col] = {
                'type': 'categorical', 'count': int(df[col].count()),
                'unique': int(df[col].nunique()),
                'mode': str(vc.index[0]) if len(vc) else 'N/A',
                'top_values': {str(k): int(v) for k, v in vc.head(10).items()},
                'null_count': int(df[col].isnull().sum()),
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
            p = save_fig(f'dist_{col.replace("/","_")}')
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
            p = save_fig(f'catcount_{col.replace("/","_")}')
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
                g = sns.pairplot(df[top_corr_cols].dropna().sample(min(500, len(df))),
                    plot_kws={'alpha': 0.5, 'color': PRIMARY, 's': 15},
                    diag_kws={'color': TEAL, 'alpha': 0.7})
                g.fig.patch.set_facecolor(DARK_BG)
                for ax in g.axes.flatten():
                    if ax: ax.set_facecolor(CARD_BG)
                g.fig.suptitle('Pairplot — Top Numeric Features', color='white', y=1.02, fontsize=12, fontweight='bold')
                p = str(viz_dir / 'pairplot.png')
                g.savefig(p, dpi=120, bbox_inches='tight', facecolor=DARK_BG)
                plt.close()
                viz_paths.append({'name': 'Pairplot', 'path': p, 'type': 'correlation'})
            except: pass

        # ── STEP 6: REPORTS ───────────────────────────
        progress('reports', 80, 'Writing reports...')

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
        with open(eda_path, 'w') as f:
            f.write('\n'.join(eda_lines))

        # Insights Report
        insights = []
        for col in num_cols_c:
            s = stats[col]
            if abs(s['skewness']) > 1:
                direction = 'right' if s['skewness'] > 0 else 'left'
                insights.append(f"**{col}** is {direction}-skewed (skewness={s['skewness']}). Consider log transformation for ML modeling.")
            if s['std'] / max(abs(s['mean']), 1e-9) > 2:
                insights.append(f"**{col}** has high coefficient of variation — highly dispersed data. Normalization recommended.")

        for col in cat_cols_c:
            s = stats[col]
            if s['unique'] > len(df) * 0.9:
                insights.append(f"**{col}** has very high cardinality ({s['unique']} unique). May be an ID column — consider dropping for ML.")

        # Correlation insights
        if len(num_cols_c) >= 2:
            corr_m = df[num_cols_c].corr().abs()
            np.fill_diagonal(corr_m.values, 0)
            top = corr_m.stack().sort_values(ascending=False).head(3)
            for (c1, c2), v in top.items():
                if v > 0.7:
                    insights.append(f"**{c1}** & **{c2}** are highly correlated (r={v:.2f}). Watch for multicollinearity in regression models.")

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
            "4. **Next Steps:** Run AutoML pipeline on cleaned_data.csv for predictive modeling.",
        ]

        ins_path = str(out_dir / 'insights_report.md')
        with open(ins_path, 'w') as f:
            f.write('\n'.join(ins_lines))

        # ── STEP 7: NOTEBOOK ──────────────────────────
        progress('notebook', 90, 'Generating notebook...')
        try:
            import nbformat as nbf
            nb = nbf.v4.new_notebook()
            cells = [
                nbf.v4.new_markdown_cell(f"# DS Agent Analysis — {Path(cfg['file_path']).name}\n*Generated by DS Agent v1.0*"),
                nbf.v4.new_code_cell("import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\nimport seaborn as sns\nplt.style.use('dark_background')\nprint('Libraries loaded ✓')"),
                nbf.v4.new_code_cell(f"df_raw = pd.read_csv('{file_path}')\nprint(f'Shape: {{df_raw.shape}}')\ndf_raw.head()"),
                nbf.v4.new_markdown_cell("## 🧹 Data Cleaning"),
                nbf.v4.new_code_cell("df = df_raw.copy()\ndf.columns = [c.strip().lower().replace(' ','_') for c in df.columns]\ndf.drop_duplicates(inplace=True)\ndf.fillna(df.median(numeric_only=True), inplace=True)\nprint('Cleaned shape:', df.shape)"),
                nbf.v4.new_markdown_cell("## 📊 EDA"),
                nbf.v4.new_code_cell("df.describe()"),
                nbf.v4.new_code_cell("num_cols = df.select_dtypes(include='number').columns\ndf[num_cols].hist(bins=20, figsize=(14,8), color='#8B7CF8', alpha=0.8)\nplt.tight_layout()\nplt.show()"),
                nbf.v4.new_code_cell("plt.figure(figsize=(10,7))\ncorr = df[num_cols].corr()\nsns.heatmap(corr, annot=True, fmt='.2f', cmap='coolwarm')\nplt.title('Correlation Matrix')\nplt.show()"),
                nbf.v4.new_markdown_cell("## 💡 Key Stats"),
                nbf.v4.new_code_cell("print('Null counts:')\nprint(df.isnull().sum())\nprint('\\nDtype summary:')\nprint(df.dtypes.value_counts())"),
            ]
            nb.cells = cells
            nb_path = str(out_dir / 'analysis_notebook.ipynb')
            with open(nb_path, 'w') as f:
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
                'cleaned_data': cleaned_path,
                'eda_report': eda_path,
                'insights_report': ins_path,
                'notebook': nb_path,
                'visualizations': [v['path'] for v in viz_paths],
            },
            'viz_info': viz_paths,
        }

        result_path = str(out_dir / 'result.json')
        with open(result_path, 'w') as f:
            json.dump(result, f, indent=2, default=str)

        progress('complete', 100, f'Done! {len(viz_paths)} charts, quality score {quality_score}/100')
        print(f"SUCCESS:{result_path}", flush=True)

    except Exception as e:
        err = traceback.format_exc()
        print(f"ERROR:{e}", flush=True, file=sys.stderr)
        print(err, file=sys.stderr)
        result = {'job_id': job_id, 'status': 'failed', 'error': str(e)}
        with open(str(out_dir / 'result.json'), 'w') as f:
            json.dump(result, f)
        sys.exit(1)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    run(args.config)
