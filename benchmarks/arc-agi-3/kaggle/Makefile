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

.PHONY: help setup test compile-skills play-local trace-click-games score-local-deterministic verify-local list-games notebook submit status model-check clean _check-kaggle

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

compile-skills: ## Compile Agent Skills into ouro_arc/distilled_skills.json
	python3 scripts/compile_skills.py
	python3 scripts/validate_skills.py

play-local: ## Run agent locally; pass GAME=ls20 and STEPS=200 as needed
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=$${OURO_ARC_DISABLE_MODEL:-1} $(VENV_PY) scripts/play_local.py $(if $(GAME),--game $(GAME)) --max-steps $(STEPS)

trace-click-games: ## Run ft09/s5i5 with frame snapshots and write HTML trace reports
	$(VENV_PY) scripts/slim_framework.py
	rm -f logs/click_trace.jsonl logs/click_summary.json
	OURO_ARC_DISABLE_MODEL=1 OURO_ARC_TRACE_FRAMES=1 \
	OURO_ARC_TRACE_PATH=logs/click_trace.jsonl \
	OURO_ARC_SUMMARY_PATH=logs/click_summary.json \
	$(VENV_PY) scripts/play_local.py --game ft09,s5i5 --max-steps 320 --results-json logs/click_results.json
	$(VENV_PY) scripts/view_trace.py logs/click_trace.jsonl --game ft09 --html logs/ft09_trace.html
	$(VENV_PY) scripts/view_trace.py logs/click_trace.jsonl --game s5i5 --html logs/s5i5_trace.html

score-local-deterministic: ## Run all public games with model disabled and compare to baseline
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --max-steps 320 --results-json logs/local_results.json
	$(VENV_PY) scripts/analyze_local_results.py logs/local_results.json

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
