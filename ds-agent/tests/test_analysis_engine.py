import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from analysis_engine import categorical_columns, clean_dataset, execute_query_plan, load_dataset, run, run_ml


class RunMLTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_compares_classification_baselines(self):
        rows = np.arange(120)
        frame = pd.DataFrame({
            'feature': np.where(rows % 13, rows, np.nan),
            'group': np.where(rows % 2, 'odd', 'even'),
            'target': np.where(rows % 2, 'yes', 'no'),
        })

        result = run_ml(frame, 'target', self.output_dir, pd, np)

        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['task'], 'classification')
        self.assertEqual(result['target'], 'target')
        self.assertEqual(len(result['models']), 3)
        self.assertEqual(result['selection_metric'], 'cv_f1_macro_mean')
        self.assertEqual(result['selection_direction'], 'maximize')
        self.assertGreaterEqual(result['cv_folds'], 2)
        self.assertTrue(all('cv_metrics' in model for model in result['models']))
        self.assertEqual(
            result['best_score'],
            next(model['cv_metrics']['f1_macro_mean'] for model in result['models'] if model['name'] == result['best_model']),
        )
        self.assertTrue((self.output_dir / 'ml_report.md').is_file())
        self.assertIn(result['best_model'], [model['name'] for model in result['models']])

    def test_compares_regression_baselines(self):
        rows = np.arange(120, dtype=float)
        frame = pd.DataFrame({'feature': rows, 'target': rows * 2 + 5})

        result = run_ml(frame, 'target', self.output_dir, pd, np)

        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['task'], 'regression')
        self.assertEqual(result['selection_metric'], 'cv_rmse_mean')
        self.assertEqual(result['selection_direction'], 'minimize')
        self.assertGreaterEqual(result['cv_folds'], 2)
        self.assertTrue(all('rmse' in model.get('metrics', {}) for model in result['models']))
        self.assertEqual(
            result['best_score'],
            min(model['cv_metrics']['rmse_mean'] for model in result['models']),
        )

    def test_engineers_date_features_and_excludes_high_cardinality_categories(self):
        rows = np.arange(400)
        frame = pd.DataFrame({
            'event_date': pd.date_range('2024-01-01', periods=len(rows), freq='D'),
            'record_key': [f'key-{row}' for row in rows],
            'feature': rows.astype(float),
            'target': np.where(rows % 2, 'yes', 'no'),
        })

        result = run_ml(frame, 'target', self.output_dir, pd, np)

        self.assertEqual(result['status'], 'completed')
        self.assertIn('event_date__year', result['engineered_date_features'])
        self.assertIn('event_date__dayofweek', result['engineered_date_features'])
        self.assertIn('record_key', result['excluded_high_cardinality_features'])
        report = (self.output_dir / 'ml_report.md').read_text(encoding='utf-8')
        self.assertIn('Cross-validation folds', report)
        self.assertIn('Engineered date features', report)

    def test_skips_missing_or_constant_targets(self):
        frame = pd.DataFrame({'feature': np.arange(20), 'target': 1})

        missing = run_ml(frame, 'unknown', self.output_dir, pd, np)
        constant = run_ml(frame, 'target', self.output_dir, pd, np)

        self.assertEqual(missing['status'], 'skipped')
        self.assertIn('not found', missing['reason'])
        self.assertEqual(constant['status'], 'skipped')
        self.assertIn('two distinct values', constant['reason'])


class LoadDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_reads_csv_excel_json_and_parquet(self):
        frame = pd.DataFrame({'value': [1, 2], 'label': ['first', 'second']})
        paths = {
            '.csv': self.directory / 'data.csv',
            '.xlsx': self.directory / 'data.xlsx',
            '.json': self.directory / 'data.json',
            '.parquet': self.directory / 'data.parquet',
        }
        frame.to_csv(paths['.csv'], index=False)
        frame.to_excel(paths['.xlsx'], index=False)
        frame.to_json(paths['.json'], orient='records')
        frame.to_parquet(paths['.parquet'], index=False)

        for file_path in paths.values():
            with self.subTest(extension=file_path.suffix):
                loaded = load_dataset(file_path, pd)
                self.assertEqual(loaded.shape, frame.shape)
                self.assertEqual(loaded.columns.tolist(), frame.columns.tolist())

    def test_reads_utf8_bom_and_legacy_encoded_csv(self):
        utf8_path = self.directory / 'utf8.csv'
        utf8_path.write_bytes('\ufeffname\nMaya\n'.encode('utf-8'))
        self.assertEqual(load_dataset(utf8_path, pd).iloc[0, 0], 'Maya')

        legacy_path = self.directory / 'legacy.csv'
        legacy_path.write_bytes(b'name\ncaf\xe9\n')
        self.assertEqual(load_dataset(legacy_path, pd).iloc[0, 0], 'café')

    def test_rejects_malformed_rows_and_unsupported_formats(self):
        malformed_path = self.directory / 'malformed.csv'
        malformed_path.write_text('a,b\n1,2\n3,4,5\n', encoding='utf-8')
        with self.assertRaises(pd.errors.ParserError):
            load_dataset(malformed_path, pd)

        unsupported_path = self.directory / 'data.txt'
        unsupported_path.write_text('not a dataset', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'Unsupported file format'):
            load_dataset(unsupported_path, pd)


class SafeQueryPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_path = Path(self.temp_dir.name) / 'cleaned.csv'
        pd.DataFrame({
            'region': ['north', 'south', 'north', 'west'],
            'sales': [10, 7, 5, 2],
            'orders': [1, 1, 2, 1],
        }).to_csv(self.data_path, index=False)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_runs_validated_group_aggregate_and_filter(self):
        result = execute_query_plan(self.data_path, {
            'operation': 'group_aggregate',
            'group_by': 'region',
            'measure': 'sales',
            'aggregation': 'sum',
            'filter': {'column': 'orders', 'operator': 'gt', 'value': 1},
            'limit': 5,
        }, pd, np)

        self.assertEqual(result['operation'], 'group_aggregate')
        self.assertEqual(result['rows'], [{'group': 'north', 'sum': 5}])

    def test_rejects_code_and_unknown_columns(self):
        with self.assertRaisesRegex(ValueError, 'unsupported fields'):
            execute_query_plan(self.data_path, {
                'operation': 'describe',
                'columns': ['sales'],
                'python': "__import__('os').system('whoami')",
            }, pd, np)
        with self.assertRaisesRegex(ValueError, 'unavailable column'):
            execute_query_plan(self.data_path, {
                'operation': 'describe',
                'columns': ['password'],
            }, pd, np)

    def test_preserves_numeric_looking_categories_and_rejects_invalid_filter_values(self):
        category_path = Path(self.temp_dir.name) / 'categories.csv'
        pd.DataFrame({'postal_code': ['00123', '00456', '00123']}).to_csv(category_path, index=False)
        result = execute_query_plan(category_path, {
            'operation': 'value_counts',
            'column': 'postal_code',
            'limit': 10,
        }, pd, np, ['postal_code'])
        self.assertEqual(result['rows'][0], {'value': '00123', 'count': 2})

        with self.assertRaisesRegex(ValueError, 'Invalid filter value'):
            execute_query_plan(self.data_path, {
                'operation': 'group_aggregate',
                'group_by': 'region',
                'measure': 'sales',
                'aggregation': 'sum',
                'filter': {'column': 'region', 'operator': 'eq', 'value': {'unexpected': 'object'}},
                'limit': 5,
            }, pd, np)


class CleanDatasetTests(unittest.TestCase):
    def test_handles_duplicate_names_and_non_numeric_missing_values(self):
        frame = pd.DataFrame({
            'Order-ID': [1, 1, 100, 3],
            'Order ID': [10, 10, 30, 40],
            'status': ['ok', 'ok', None, 'keep'],
            'event_time': pd.to_datetime(['2024-01-01', '2024-01-01', None, '2024-01-02']),
            'sparse': [None, None, None, 1],
            'score': [1, 1, None, 3],
        })

        cleaned, ml_frame, clean_log, _, dropped, raw_null_counts = clean_dataset(frame, pd)

        self.assertEqual(cleaned.columns.tolist(), ['order_id', 'order_id_2', 'status', 'event_time', 'score'])
        self.assertEqual(len(cleaned), 3)
        self.assertEqual(cleaned['status'].isna().sum(), 0)
        self.assertEqual(cleaned['event_time'].isna().sum(), 0)
        self.assertEqual(cleaned['score'].isna().sum(), 0)
        self.assertEqual(ml_frame['score'].isna().sum(), 1)
        self.assertEqual(dropped, ['sparse'])
        self.assertEqual(raw_null_counts['status'], 1)
        self.assertEqual(raw_null_counts['event_time'], 1)
        self.assertEqual(raw_null_counts['score'], 1)
        self.assertTrue(any('duplicate rows' in entry for entry in clean_log))

    def test_caps_extreme_numeric_outliers(self):
        frame = pd.DataFrame({'metric': list(range(1, 11)) + [1000]})

        cleaned, _, _, outlier_log, _, _ = clean_dataset(frame, pd)

        self.assertEqual(cleaned['metric'].max(), 16)
        self.assertEqual(len(outlier_log), 1)


class EdaColumnTests(unittest.TestCase):
    def test_includes_string_category_and_boolean_columns(self):
        frame = pd.DataFrame({
            'object': ['a', 'b'],
            'string': pd.Series(['a', 'b'], dtype='string'),
            'category': pd.Series(['a', 'b'], dtype='category'),
            'flag': [True, False],
            'number': [1, 2],
        })

        self.assertEqual(
            categorical_columns(frame),
            ['object', 'string', 'category', 'flag'],
        )


class AnalysisRunTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_eda_generates_profiles_reports_and_visualizations(self):
        frame = pd.DataFrame({
            'measure': list(range(13)),
            'amount': [2, 4, None, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26],
            'segment': ['north', 'south'] * 6 + [None],
        })
        data_path = self.directory / 'data.csv'
        frame.to_csv(data_path, index=False)
        config_path = self.directory / 'config.json'
        output_dir = self.directory / 'output'
        config_path.write_text(json.dumps({
            'job_id': 'eda-test',
            'file_path': str(data_path),
            'output_dir': str(output_dir),
            'analysis_type': 'full',
            'target_col': 'segment',
        }), encoding='utf-8')

        run(config_path)
        result = json.loads((output_dir / 'result.json').read_text(encoding='utf-8'))

        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['ml']['status'], 'completed')
        self.assertEqual(result['stats']['amount']['null_count'], 1)
        self.assertEqual(result['stats']['segment']['null_count'], 1)
        self.assertIn('segment', result['cat_cols'])
        correlation_insights = [
            insight for insight in result['insights']
            if 'highly correlated' in insight
        ]
        self.assertEqual(len(correlation_insights), 1)
        self.assertTrue((output_dir / 'eda_report.md').is_file())
        self.assertTrue((output_dir / 'insights_report.md').is_file())
        self.assertTrue((output_dir / 'ml_report.md').is_file())
        self.assertTrue(result['files']['visualizations'])
        self.assertTrue(all((output_dir / file_path).is_file() for file_path in result['files']['visualizations']))


if __name__ == '__main__':
    unittest.main()
