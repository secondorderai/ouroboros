# ARC-AGI-3 Kaggle submission workflow.

PYTHON          ?= python3.12
VENV            := .venv
VENV_PY         := $(VENV)/bin/python
VENV_PIP        := $(VENV)/bin/pip
KAGGLE          := KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV)/bin/kaggle
FRAMEWORK_REPO  := https://github.com/arcprize/ARC-AGI-3-Agents.git
FRAMEWORK_DIR   := vendor/ARC-AGI-3-Agents
GAME            ?=
STEPS           ?= 200

.PHONY: help setup test play-local verify-local list-games notebook submit status model-check clean _check-kaggle

help:
	@awk 'BEGIN{FS=":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  %-15s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

setup: ## Create venv, install local tooling, and clone ARC-AGI-3-Agents
	$(PYTHON) -m venv $(VENV)
	$(VENV_PIP) install --upgrade pip
	$(VENV_PIP) install "arc-agi>=0.9.9" "kaggle>=2.2" python-dotenv pandas pyarrow pytest
	@if [ ! -d "$(FRAMEWORK_DIR)/.git" ]; then \
	    mkdir -p vendor && git clone --depth 1 $(FRAMEWORK_REPO) $(FRAMEWORK_DIR); \
	else \
	    git -C $(FRAMEWORK_DIR) pull --ff-only; \
	fi
	$(VENV_PY) scripts/slim_framework.py

test: ## Run deterministic unit tests
	python3 -m unittest discover -s tests

play-local: ## Run agent locally; pass GAME=ls20 and STEPS=200 as needed
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=$${OURO_ARC_DISABLE_MODEL:-1} $(VENV_PY) scripts/play_local.py $(if $(GAME),--game $(GAME)) --max-steps $(STEPS)

verify-local: ## 50-action smoke test on ls20 and vc33 without loading Gemma
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --game ls20,vc33 --max-steps 50

list-games: ## List local ARC-AGI-3 environments
	$(VENV_PY) scripts/slim_framework.py
	$(VENV_PY) scripts/play_local.py --list

notebook: ## Build notebooks/submission.ipynb
	$(VENV_PY) scripts/build_notebook.py

model-check: ## Validate OURO_ARC_MODEL_PATH or a Gemma Kaggle input path
	$(VENV_PY) scripts/package_model.py --check "$${OURO_ARC_MODEL_PATH:-}"

_check-kaggle:
	@if [ ! -s .kaggle/access_token ]; then \
	    echo "ERROR: .kaggle/access_token is missing. Put a one-line Kaggle API token there."; \
	    exit 1; \
	fi

submit: notebook _check-kaggle ## Push generated notebook to Kaggle
	@grep -q REPLACE_WITH_YOUR_USERNAME notebooks/kernel-metadata.json && { \
	    echo "ERROR: edit notebooks/kernel-metadata.json and replace REPLACE_WITH_YOUR_USERNAME"; \
	    exit 1; } || true
	$(KAGGLE) kernels push -p notebooks/

status: _check-kaggle ## Show latest Kaggle kernel status
	@KERNEL_ID=$$(python3 -c "import json; print(json.load(open('notebooks/kernel-metadata.json'))['id'])"); \
	$(KAGGLE) kernels status $$KERNEL_ID

clean: ## Remove generated local artifacts
	rm -rf $(VENV) vendor environment_files recordings reference logs.log \
	       notebooks/submission.ipynb __pycache__ .pytest_cache
