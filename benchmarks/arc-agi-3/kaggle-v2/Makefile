PY := .venv/bin/python
PIP := .venv/bin/pip
FRAMEWORK := vendor/ARC-AGI-3-Agents

.PHONY: setup test play-local holdout rehearse notebook submit lint

PYTHON ?= python3.12

setup:
	$(PYTHON) -m venv .venv
	$(PIP) install -q --upgrade pip
	$(PIP) install -q pytest "arc-agi>=0.9.9" python-dotenv
	@test -d $(FRAMEWORK) || git clone -q https://github.com/arcprize/ARC-AGI-3-Agents $(FRAMEWORK)
	@test -e environment_files || ln -s ../kaggle/environment_files environment_files
	@echo "setup complete"

test:
	$(PY) -m pytest
	$(PY) scripts/holdout_gate.py --lint-only

play-local:
	$(PY) scripts/play_local.py $(ARGS)

holdout:
	$(PY) scripts/play_local.py --fold dev --results-json baselines/dev_latest.json
	$(PY) scripts/play_local.py --fold test --results-json baselines/test_latest.json
	$(PY) scripts/holdout_gate.py --dev baselines/dev_latest.json --test baselines/test_latest.json

rehearse:
	$(PY) scripts/rehearse.py

notebook:
	$(PY) scripts/holdout_gate.py --check-only
	$(PY) scripts/build_notebook.py $(ARGS)

submit: notebook
	cd notebooks && kaggle kernels push -p .
