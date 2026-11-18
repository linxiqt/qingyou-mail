"""Validate OpenAPI and captured isolated-server exchanges; no network/credentials."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
LOCAL_VALIDATOR = ROOT / '.tooling' / 'api-docs-validator'
if LOCAL_VALIDATOR.is_dir():
    sys.path.insert(0, str(LOCAL_VALIDATOR))
from openapi_spec_validator import validate
from openapi_schema_validator import OAS30Validator
from jsonschema import RefResolver

for name in ('openapi.json', 'openapi-mail.json'):
    validate(json.loads((ROOT / 'docs' / 'api' / name).read_text(encoding='utf-8')))
spec = json.loads((ROOT / 'docs/api/openapi.json').read_text(encoding='utf-8'))
operations = {op['operationId']: op for methods in spec['paths'].values() for op in methods.values()}
resolver = RefResolver.from_schema(spec)
cases = json.loads((ROOT / 'test-results/api-docs-contract-cases.json').read_text(encoding='utf-8'))
for case in cases:
    op = operations[case['operationId']]
    # Invalid-input tests deliberately do not have to pass the input schema.
    if case['status'] < 300:
        if 'requestBody' in op:
            schema = op['requestBody']['content']['application/json']['schema']
            OAS30Validator(schema, resolver=resolver).validate(case['args']['body'])
        for param in op.get('parameters', []):
            value = case['args'].get(param['in'], {}).get(param['name'])
            if value is not None:
                OAS30Validator(param['schema'], resolver=resolver).validate(value)
    response = op['responses'].get(str(case['status']), op['responses']['default'])
    try:
        schema = response['content'][case['contentType']]['schema']
        OAS30Validator(schema, resolver=resolver).validate(case['response'])
    except Exception as error:
        raise RuntimeError(f"{case['operationId']} HTTP {case['status']}: {error}") from error
print(f"2 OpenAPI documents valid; {len(operations)} operations; {len(cases)} real HTTP exchanges conform.")
