"""Restricted static flit build: no project imports or arbitrary backend hooks."""
import hashlib
import json
import pathlib
import re
import sys
import tomllib

root = pathlib.Path('/work')

def inspect():
    data = tomllib.loads((root / 'pyproject.toml').read_text())
    if set(data) != {'build-system', 'project'}:
        raise ValueError('Only [build-system] and static [project] metadata are supported; no tool configuration or custom hooks.')
    if data['build-system'] != {'requires': ['flit_core==3.12.0'], 'build-backend': 'flit_core.buildapi'}:
        raise ValueError('Only pinned flit_core==3.12.0 with no backend-path is supported.')
    project = data['project']
    if set(project) - {'name', 'version', 'description', 'requires-python', 'dependencies', 'scripts'}:
        raise ValueError('Unsupported project metadata (dynamic fields, optional dependencies and custom entry points are unavailable).')
    for key in ['name', 'version', 'description', 'requires-python']:
        if not isinstance(project.get(key), str) or not project[key]:
            raise ValueError(f'Static project.{key} is required.')
    if not re.fullmatch(r'[a-z][a-z0-9_]*', project['name']):
        raise ValueError('Project name must be a lowercase Python identifier; use src/<name>/__init__.py.')
    if not re.fullmatch(r'\d+\.\d+\.\d+', project['version']):
        raise ValueError('Use a static three-part package version.')
    if project['requires-python'] != '==' + (root / '.python-version').read_text().strip():
        raise ValueError('requires-python must exactly match .python-version.')
    locked = {}
    for line in (root / 'requirements.lock').read_text().replace('\\\n', ' ').splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            name, version = line.split()[0].split('==')
            locked[re.sub(r'[-_.]+', '-', name).lower()] = version
    if re.sub(r'[-_.]+', '-', project['name']) in locked or project['name'] == 'pip':
        raise ValueError('The project name must not shadow a locked dependency or pip.')
    deps = project.get('dependencies', [])
    if not isinstance(deps, list):
        raise ValueError('project.dependencies must be a list of exact name==version requirements.')
    for dep in deps:
        match = re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9._-]*)==([0-9][A-Za-z0-9.!+_-]*)', dep) if isinstance(dep, str) else None
        if not match or locked.get(re.sub(r'[-_.]+', '-', match[1]).lower()) != match[2]:
            raise ValueError('Every project dependency must match its exact requirements.lock version; no local/Git/URL dependencies.')
    scripts = project.get('scripts', {})
    if not isinstance(scripts, dict) or any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', name) or not isinstance(target, str) or not re.fullmatch(re.escape(project['name']) + r'(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*', target) for name, target in scripts.items()):
        raise ValueError('Console scripts must name functions inside the single package.')
    return project

project = inspect()
if sys.argv[1] == 'inspect':
    print(json.dumps(project))
elif sys.argv[1] == 'build':
    package = root / 'src' / project['name']
    if not (package / '__init__.py').is_file() or sorted(p.name for p in (root / 'src').iterdir() if p.name != '__pycache__') != [project['name']]:
        raise ValueError('Exactly one src/<project_name>/ package with __init__.py is supported.')
    if any(p.suffix not in {'.py', '.pyi', '.txt', '.json', '.csv', '.md', '.toml'} for p in package.rglob('*') if p.is_file() and '__pycache__' not in p.parts):
        raise ValueError('Only pure Python and simple package data are supported, without native extensions.')
    from flit_core.buildapi import build_wheel
    (root / 'dist').mkdir(exist_ok=True)
    filename = build_wheel(str(root / 'dist'))
    wheel = root / 'dist' / filename
    print('HARNESS_WHEEL=' + json.dumps({'file': filename, 'sha256': hashlib.sha256(wheel.read_bytes()).hexdigest()}))
else:
    raise ValueError('Unknown package operation')
