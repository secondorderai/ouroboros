import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_notebook_emits_required_cells(tmp_path):
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_notebook.py"), "--out", str(tmp_path)],
        check=True,
        capture_output=True,
    )
    nb = json.loads((tmp_path / "submission.ipynb").read_text())
    sources = ["".join(c["source"]) for c in nb["cells"]]
    joined = "\n".join(sources)
    assert "--no-index" in joined and "arc_agi_3_wheels" in joined
    assert "%%writefile /tmp/ouro2/director.py" in joined
    assert "%%writefile /tmp/my_agent.py" in joined
    assert "KAGGLE_IS_COMPETITION_RERUN" in joined
    assert "gateway:8001" in joined
    assert "submission.parquet" in joined
    assert "AVAILABLE_AGENTS" in joined
    meta = json.loads((tmp_path / "kernel-metadata.json").read_text())
    assert meta["enable_internet"] is False
    assert meta["competition_sources"] == ["arc-prize-2026-arc-agi-3"]
    assert meta["model_sources"] == []  # deterministic default


def test_notebook_model_variant_attaches_model(tmp_path):
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "build_notebook.py"),
            "--model",
            "--out",
            str(tmp_path),
        ],
        check=True,
        capture_output=True,
    )
    meta = json.loads((tmp_path / "kernel-metadata.json").read_text())
    assert meta["model_sources"], "model variant must attach the Kaggle model"
    nb = json.loads((tmp_path / "submission.ipynb").read_text())
    joined = "\n".join("".join(c["source"]) for c in nb["cells"])
    assert 'OURO2_DISABLE_MODEL", "0"' in joined
    # The save-run smoke must exercise the real transformers load path and
    # stay fail-open (traceback, not raise) so it can never sink a save.
    assert "model-smoke" in joined
    assert "._transformers(" in joined
    assert "traceback.print_exc()" in joined
