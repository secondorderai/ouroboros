# ARC-AGI-3 Kaggle submission workflow.

PYTHON          ?= python3.12
VENV            := .venv
VENV_PY         := $(VENV)/bin/python
VENV_PIP        := $(VENV)/bin/pip
KAGGLE          := KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV)/bin/kaggle
GPU_KERNEL_ID   ?= kinwochan/ouroboros-qwen3-5-4b-rtx-6000-public-validation
GPU_DATASET_ID  ?= kinwochan/ouroboros-arc-gpu-validation-assets
QWEN_MODEL_ID   ?= kinwochan/qwen-3-5-4b
QWEN36_MODEL_ID ?= kinwochan/qwen-3-6-27b-fp8
QWEN_RUNTIME_DATASET_ID ?= kinwochan/ouroboros-qwen-runtime-wheels
GPU_NOTEBOOK_DIR := notebooks/gpu-validation
QWEN36_GPU_KERNEL_ID ?= kinwochan/ouroboros-qwen3-6-27b-fp8-rtx-validation
QWEN36_GPU_NOTEBOOK_DIR := notebooks/gpu-validation-qwen36
GPU_ASSETS_DIR  := $(GPU_NOTEBOOK_DIR)/assets
GPU_RESULTS_DIR := logs/kaggle-qwen-validation
QWEN36_GPU_RESULTS_DIR := logs/kaggle-qwen36-validation
QWEN36_SUBMISSION_KERNEL_ID ?= kinwochan/ouroboros-arc-agi-3-qwen36-fp8
QWEN36_SUBMISSION_NOTEBOOK_DIR := notebooks/submission-qwen36
QWEN36_PROMOTION_CONFIG := config/qwen36_promoted.json
GPU_STAGE        ?= smoke
GPU_SELECTED_MODE ?=
GPU_MAX_CALLS    ?=
GPU_MAX_NEW_TOKENS ?=
BASELINE_STUDY   ?= 0
FRAMEWORK_REPO  := https://github.com/arcprize/ARC-AGI-3-Agents.git
FRAMEWORK_DIR   := vendor/ARC-AGI-3-Agents
GAME            ?=
STEPS           ?= 200
TRACE            ?= logs/ouro_arc_trace.jsonl
LOCAL_OLLAMA_MODEL ?= qwen3.5:4b-mlx
LOCAL_OLLAMA_THINK ?= 1
LOCAL_OLLAMA_NUM_PREDICT ?= 4096

.PHONY: help setup test compile-skills play-local trace-click-games replay-world-model score-local-deterministic score-local-qwen smoke-ollama-causal trace-causal-game score-local-qwen-causal score-local-qwen-causal-transfer score-local-qwen-causal-no-transfer compare-causal-ablation audit-generated-model generalization-report verify-local list-games notebook submit status model-check qwen-model-stage qwen-model-push qwen36-model-check qwen36-model-stage qwen36-model-push qwen-runtime-wheels qwen-runtime-wheels-push clean _check-kaggle holdout overfit-lint _holdout-gate-check kaggle-gpu-assets kaggle-gpu-assets-push kaggle-gpu-build kaggle-gpu-build-causal kaggle-gpu-push kaggle-gpu-push-causal kaggle-gpu-status kaggle-gpu-pull kaggle-gpu-analyze kaggle-gpu-promote kaggle-qwen36-gpu-build kaggle-qwen36-gpu-push kaggle-qwen36-gpu-status kaggle-qwen36-gpu-pull kaggle-qwen36-gpu-analyze kaggle-qwen36-gpu-promote kaggle-qwen36-submission-build kaggle-qwen36-submission-push kaggle-qwen36-submission-status

help:
	@awk 'BEGIN{FS=":.*##"} /^[a-zA-Z_-]+:.*##/ {printf "  %-15s %s\n",$$1,$$2}' $(MAKEFILE_LIST)

setup: ## Create venv, install local tooling, and clone ARC-AGI-3-Agents
	$(PYTHON) -m venv $(VENV)
	$(VENV_PIP) install --upgrade pip
	$(VENV_PIP) install "arc-agi>=0.9.9" "kaggle>=2.2" "huggingface-hub>=0.36" python-dotenv pandas pyarrow pytest
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

replay-world-model: ## Replay deterministic induction from TRACE without ARC or an LLM
	$(VENV_PY) scripts/replay_world_model.py $(TRACE)

score-local-deterministic: ## Run all public games with model disabled and compare to baseline
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --max-steps 320 --results-json logs/local_results.json
	$(VENV_PY) scripts/analyze_local_results.py logs/local_results.json

score-local-qwen: ## Run CPU world-model search with stuck-only Qwen hypothesis ranking
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=0 \
	OURO_ARC_MODEL_CONFIG=config/qwen_candidate.json \
	OURO_ARC_MODEL_BACKEND=ollama \
	OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	OURO_ARC_MODEL_THINK=$(LOCAL_OLLAMA_THINK) \
	OURO_ARC_MODEL_NUM_PREDICT=$(LOCAL_OLLAMA_NUM_PREDICT) \
	$(VENV_PY) scripts/play_local.py --model --max-steps 320 \
		--results-json logs/ollama_qwen35_4b_world_model_results.json

smoke-ollama-causal: ## Run one synthetic Qwen physicist/critic authoring cycle
	OURO_ARC_MODEL_CONFIG=config/qwen_autonomous_candidate.json \
	OURO_ARC_MODEL_BACKEND=ollama OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	$(VENV_PY) scripts/smoke_ollama_causal.py

trace-causal-game: ## Run one autonomous-model game with full frame/model telemetry
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=0 OURO_ARC_TRACE_FRAMES=1 \
	OURO_ARC_TRACE_PATH=logs/causal_$${GAME:-ls20}_trace.jsonl \
	OURO_ARC_GENERATED_MODEL_DIR=logs/generated_models \
	OURO_ARC_MODEL_CONFIG=config/qwen_autonomous_candidate.json \
	OURO_ARC_MODEL_BACKEND=ollama OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	$(VENV_PY) scripts/play_local.py --model --game $${GAME:-ls20} --max-steps $(STEPS) \
		--results-json logs/causal_$${GAME:-ls20}_results.json

score-local-qwen-causal: ## Run all public games with autonomous Python and no helper transfer
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=0 OURO_ARC_MODEL_CONFIG=config/qwen_autonomous_candidate.json \
	OURO_ARC_GENERATED_MODEL_DIR=logs/generated_models \
	OURO_ARC_MODEL_BACKEND=ollama OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	$(VENV_PY) scripts/play_local.py --model --max-steps 320 \
		--results-json logs/ollama_qwen35_4b_causal_results.json

score-local-qwen-causal-transfer: ## Run all public games with verified sequential helper transfer
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=0 OURO_ARC_MODEL_CONFIG=config/qwen_autonomous_transfer_candidate.json \
	OURO_ARC_GENERATED_MODEL_DIR=logs/generated_models_transfer \
	OURO_ARC_MODEL_BACKEND=ollama OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	$(VENV_PY) scripts/play_local.py --model --max-steps 320 \
		--results-json logs/ollama_qwen35_4b_causal_transfer_results.json

score-local-qwen-causal-no-transfer: ## Ablate shared helper transfer
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=0 OURO_ARC_MODEL_CONFIG=config/qwen_autonomous_candidate.json \
	OURO_ARC_GENERATED_MODEL_DIR=logs/generated_models_no_transfer \
	OURO_ARC_SHARED_MECHANICS=0 OURO_ARC_MODEL_BACKEND=ollama \
	OURO_ARC_OLLAMA_MODEL=$(LOCAL_OLLAMA_MODEL) \
	$(VENV_PY) scripts/play_local.py --model --max-steps 320 \
		--results-json logs/ollama_qwen35_4b_causal_no_transfer_results.json

compare-causal-ablation: ## Compare available autonomous-model result files
	$(VENV_PY) scripts/compare_causal_ablation.py \
		logs/ollama_qwen35_4b_causal_results.json \
		logs/ollama_qwen35_4b_causal_transfer_results.json

audit-generated-model: ## Audit SOURCE=/path/to/world_model.py in the isolated worker
	$(VENV_PY) scripts/audit_generated_model.py $(SOURCE)

generalization-report: ## Compare the latest deterministic run across fixed five-way folds
	$(VENV_PY) scripts/analyze_generalization.py logs/local_results.json \
		--baseline baselines/deterministic_public_v11.json \
		--json-output logs/generalization_report.json \
		--markdown-output logs/generalization_report.md

holdout: ## Run the 25-game + TEST-fold deterministic plays and ratchet the holdout baseline
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --max-steps 320 --results-json logs/local_results.json
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --game vc33,lf52,su15,sc25,g50t,wa30,ka59,dc22,tn36 --max-steps 320 --results-json logs/test_fold_results.json
	$(VENV_PY) scripts/holdout_gate.py --results logs/local_results.json --test-results logs/test_fold_results.json --update

overfit-lint: ## Lint the ouro_arc/agent/skills diff for reintroduced game-specificity
	$(VENV_PY) scripts/overfit_lint.py

verify-local: ## 50-action smoke test on ls20 and vc33 without loading Qwen
	$(VENV_PY) scripts/slim_framework.py
	OURO_ARC_DISABLE_MODEL=1 $(VENV_PY) scripts/play_local.py --game ls20,vc33 --max-steps 50

list-games: ## List local ARC-AGI-3 environments
	$(VENV_PY) scripts/slim_framework.py
	$(VENV_PY) scripts/play_local.py --list

_holdout-gate-check:
	@if [ "$(BASELINE_STUDY)" = "1" ]; then \
	    echo 'holdout gate bypassed for explicitly approved baseline study'; \
	elif [ -f logs/local_results.json ]; then \
	    $(VENV_PY) scripts/holdout_gate.py --check-only --results logs/local_results.json $(if $(wildcard logs/test_fold_results.json),--test-results logs/test_fold_results.json) \
	        || { echo 'holdout gate blocked build; use scripts/holdout_gate.py --allow-regression to override'; exit 1; }; \
	else \
	    echo 'holdout gate: no logs/local_results.json yet, skipping check'; \
	fi

notebook: _holdout-gate-check ## Build notebooks/submission.ipynb
	$(VENV_PY) scripts/build_notebook.py

model-check: ## Validate a staged Qwen snapshot
	$(VENV_PY) scripts/package_qwen_model.py --verify-only "$${OURO_ARC_MODEL_PATH:-notebooks/qwen-model/instance}"

qwen-model-stage: ## Download and verify the pinned official Qwen3.5-4B snapshot
	$(VENV_PY) scripts/package_qwen_model.py --download

qwen-model-push: qwen-model-stage _check-kaggle ## Publish the private Qwen Kaggle Model source
	@if $(KAGGLE) models get $(QWEN_MODEL_ID) >/dev/null 2>&1; then \
		KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV_PY) scripts/publish_kaggle_model.py notebooks/qwen-model/instance; \
	else \
		$(KAGGLE) models create -p notebooks/qwen-model/model; \
		KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV_PY) scripts/publish_kaggle_model.py notebooks/qwen-model/instance; \
	fi

qwen36-model-check: ## Validate a staged Qwen3.6-27B-FP8 snapshot
	$(VENV_PY) scripts/package_qwen_model.py --profile qwen36-27b-fp8 \
		--verify-only "$${OURO_ARC_MODEL_PATH:-notebooks/qwen36-model/instance}"

qwen36-model-stage: ## Download and verify pinned Qwen3.6-27B-FP8 weights
	$(VENV_PY) scripts/package_qwen_model.py --profile qwen36-27b-fp8 --download

qwen36-model-push: qwen36-model-stage _check-kaggle ## Publish private Qwen3.6 FP8 Kaggle Model
	@if $(KAGGLE) models get $(QWEN36_MODEL_ID) >/dev/null 2>&1; then \
		KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV_PY) scripts/publish_kaggle_model.py notebooks/qwen36-model/instance; \
	else \
		$(KAGGLE) models create -p notebooks/qwen36-model/model; \
		KAGGLE_API_TOKEN=$$(cat .kaggle/access_token) $(VENV_PY) scripts/publish_kaggle_model.py notebooks/qwen36-model/instance; \
	fi

qwen-runtime-wheels: ## Build the offline Transformers wheel dataset for submissions
	$(VENV_PY) scripts/build_qwen_runtime_wheels.py --dataset-id $(QWEN_RUNTIME_DATASET_ID)

qwen-runtime-wheels-push: qwen-runtime-wheels _check-kaggle ## Publish Qwen runtime wheels
	@if $(KAGGLE) datasets status $(QWEN_RUNTIME_DATASET_ID) >/dev/null 2>&1; then \
		$(KAGGLE) datasets version -p notebooks/qwen-runtime-wheels -m "Refresh Qwen runtime wheels"; \
	else \
		$(KAGGLE) datasets create -p notebooks/qwen-runtime-wheels; \
	fi

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

kaggle-gpu-assets: ## Build private public-game assets and offline Qwen wheelhouse
	$(VENV_PY) scripts/build_gpu_validation_assets.py \
		--dataset-id $(GPU_DATASET_ID) --download-wheels

kaggle-gpu-assets-push: kaggle-gpu-assets _check-kaggle ## Publish or version private validation assets
	@if $(KAGGLE) datasets status $(GPU_DATASET_ID) >/dev/null 2>&1; then \
		$(KAGGLE) datasets version -p $(GPU_ASSETS_DIR) -m "Refresh ARC GPU validation assets"; \
	else \
		$(KAGGLE) datasets create -p $(GPU_ASSETS_DIR); \
	fi

kaggle-gpu-build: ## Generate the isolated private RTX 6000 validation kernel
	OURO_ARC_KAGGLE_GPU_KERNEL_ID=$(GPU_KERNEL_ID) \
	OURO_ARC_KAGGLE_GPU_DATASET_ID=$(GPU_DATASET_ID) \
	OURO_ARC_VALIDATION_STAGE=$(GPU_STAGE) \
	OURO_ARC_VALIDATION_SELECTED_MODE=$(GPU_SELECTED_MODE) \
	$(VENV_PY) scripts/build_gpu_validation_notebook.py

kaggle-gpu-build-causal: ## Generate the autonomous-model RTX validation kernel
	OURO_ARC_GPU_AUTONOMOUS=1 \
	OURO_ARC_KAGGLE_GPU_KERNEL_ID=$(GPU_KERNEL_ID) \
	OURO_ARC_KAGGLE_GPU_DATASET_ID=$(GPU_DATASET_ID) \
	OURO_ARC_VALIDATION_STAGE=$(GPU_STAGE) \
	OURO_ARC_VALIDATION_SELECTED_MODE=$(GPU_SELECTED_MODE) \
	$(VENV_PY) scripts/build_gpu_validation_notebook.py

kaggle-gpu-push: kaggle-gpu-build _check-kaggle ## Push the private RTX 6000 validation kernel
	$(KAGGLE) kernels push -p $(GPU_NOTEBOOK_DIR) --accelerator NvidiaRtxPro6000

kaggle-gpu-push-causal: kaggle-gpu-build-causal _check-kaggle ## Push the autonomous RTX validation kernel
	$(KAGGLE) kernels push -p $(GPU_NOTEBOOK_DIR) --accelerator NvidiaRtxPro6000

kaggle-gpu-status: _check-kaggle ## Show the private GPU validation kernel status
	$(KAGGLE) kernels status $(GPU_KERNEL_ID)

kaggle-gpu-pull: _check-kaggle ## Pull GPU validation outputs from Kaggle
	mkdir -p $(GPU_RESULTS_DIR)
	$(KAGGLE) kernels output $(GPU_KERNEL_ID) -p $(GPU_RESULTS_DIR) --force

kaggle-gpu-analyze: ## Compare pulled Qwen GPU results with deterministic and local baselines
	$(VENV_PY) scripts/analyze_gpu_validation.py \
		$(GPU_RESULTS_DIR)/qwen_gpu_validation.json

kaggle-gpu-promote: ## Write submission config only when the GPU promotion gate passes
	$(VENV_PY) scripts/promote_gpu_validation.py \
		$(GPU_RESULTS_DIR)/qwen_gpu_validation.json \
		config/qwen_promoted.json

kaggle-qwen36-gpu-build: ## Build separate Qwen3.6-27B-FP8 RTX validation notebook
	OURO_ARC_GPU_MODEL_PROFILE=qwen36-27b-fp8 \
	OURO_ARC_GPU_NOTEBOOK_DIR=$(QWEN36_GPU_NOTEBOOK_DIR) \
	OURO_ARC_KAGGLE_GPU_KERNEL_ID=$(QWEN36_GPU_KERNEL_ID) \
	OURO_ARC_KAGGLE_GPU_DATASET_ID=$(GPU_DATASET_ID) \
	OURO_ARC_VALIDATION_STAGE=$(GPU_STAGE) \
	OURO_ARC_VALIDATION_SELECTED_MODE=$(GPU_SELECTED_MODE) \
	OURO_ARC_VALIDATION_MAX_CALLS=$(GPU_MAX_CALLS) \
	OURO_ARC_VALIDATION_MAX_NEW_TOKENS=$(GPU_MAX_NEW_TOKENS) \
	$(VENV_PY) scripts/build_gpu_validation_notebook.py

kaggle-qwen36-gpu-push: kaggle-qwen36-gpu-build _check-kaggle ## Launch Qwen3.6 RTX validation
	$(KAGGLE) kernels push -p $(QWEN36_GPU_NOTEBOOK_DIR) --accelerator NvidiaRtxPro6000

kaggle-qwen36-gpu-status: _check-kaggle ## Show Qwen3.6 RTX validation status
	$(KAGGLE) kernels status $(QWEN36_GPU_KERNEL_ID)

kaggle-qwen36-gpu-pull: _check-kaggle ## Pull Qwen3.6 RTX validation outputs
	mkdir -p $(QWEN36_GPU_RESULTS_DIR)
	$(KAGGLE) kernels output $(QWEN36_GPU_KERNEL_ID) \
		-p $(QWEN36_GPU_RESULTS_DIR) --force --page-size 200 \
		--file-pattern 'qwen_gpu_(validation|preflight)|traces/'

kaggle-qwen36-gpu-analyze: ## Analyze Qwen3.6 GPU results
	$(VENV_PY) scripts/analyze_gpu_validation.py \
		$(QWEN36_GPU_RESULTS_DIR)/qwen_gpu_validation.json

kaggle-qwen36-gpu-promote: ## Promote Qwen3.6; set BASELINE_STUDY=1 for an approved failed-run study
	$(VENV_PY) scripts/promote_gpu_validation.py \
		$(QWEN36_GPU_RESULTS_DIR)/qwen_gpu_validation.json \
		$(QWEN36_PROMOTION_CONFIG) \
		$(if $(filter 1,$(BASELINE_STUDY)),--allow-failed-validation,)

kaggle-qwen36-submission-build: _holdout-gate-check ## Build the promoted Qwen3.6 competition notebook
	OURO_ARC_SUBMISSION_QWEN=1 \
	OURO_ARC_SUBMISSION_MODEL_PROFILE=qwen36-27b-fp8 \
	OURO_ARC_QWEN_PROMOTION_CONFIG=$(QWEN36_PROMOTION_CONFIG) \
	OURO_ARC_SUBMISSION_NOTEBOOK_DIR=$(QWEN36_SUBMISSION_NOTEBOOK_DIR) \
	OURO_ARC_SUBMISSION_KERNEL_ID=$(QWEN36_SUBMISSION_KERNEL_ID) \
	$(VENV_PY) scripts/build_notebook.py

kaggle-qwen36-submission-push: kaggle-qwen36-submission-build _check-kaggle ## Push the promoted Qwen3.6 competition notebook
	$(KAGGLE) kernels push -p $(QWEN36_SUBMISSION_NOTEBOOK_DIR) --accelerator NvidiaRtxPro6000

kaggle-qwen36-submission-status: _check-kaggle ## Show Qwen3.6 competition notebook status
	$(KAGGLE) kernels status $(QWEN36_SUBMISSION_KERNEL_ID)

clean: ## Remove generated local artifacts
	rm -rf $(VENV) vendor environment_files recordings reference logs.log \
	       notebooks/submission.ipynb __pycache__ .pytest_cache
