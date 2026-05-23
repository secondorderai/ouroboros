import os
import shlex
import shutil
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


REPO_ROOT = Path(__file__).resolve().parents[2]
CONTAINER_REPO_DIR = "/installed-agent/ouroboros"
CONTAINER_HOME_CONFIG_DIR = "/installed-agent/ouroboros-host-home"
CONTAINER_OUROBOROS_CONFIG = f"{CONTAINER_HOME_CONFIG_DIR}/.ouroboros"
AGENT_LOG_NAME = "ouroboros.txt"
AGENT_STDOUT_NAME = "ouroboros-stdout.txt"
AGENT_STDERR_NAME = "ouroboros-stderr.txt"


def _env_or_default(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value and value.strip() else default


def _env_or_none(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value and value.strip() else None


class OuroborosInstalledAgent(BaseInstalledAgent):
    """Harbor installed-agent adapter for running Ouroboros CLI on TB 2.0."""

    SUPPORTS_ATIF = False

    @staticmethod
    def name() -> str:
        return "ouroboros"

    def get_version_command(self) -> str | None:
        return (
            f"cd {shlex.quote(CONTAINER_REPO_DIR)} && "
            "./packages/cli/dist/ouroboros --version"
        )

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "if command -v apk >/dev/null 2>&1; then "
                "apk add --no-cache bash curl unzip ca-certificates tar; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "apt-get update && apt-get install -y "
                "bash curl unzip ca-certificates tar; "
                "elif command -v yum >/dev/null 2>&1; then "
                "yum install -y bash curl unzip ca-certificates tar; "
                "else "
                "echo 'No supported package manager found; assuming prerequisites exist' >&2; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
            timeout_sec=300,
        )

        await self.exec_as_agent(
            environment,
            command=(
                "if ! command -v bun >/dev/null 2>&1; then "
                "curl -fsSL https://bun.sh/install | bash; "
                "fi"
            ),
            timeout_sec=300,
        )

        upload_dir = self._prepare_repo_upload()
        await environment.upload_dir(upload_dir, CONTAINER_REPO_DIR)

        host_config = self._host_ouroboros_config_path()
        if host_config.exists():
            await self.exec_as_root(
                environment,
                command=f"mkdir -p {shlex.quote(CONTAINER_HOME_CONFIG_DIR)}",
            )
            await environment.upload_file(host_config, CONTAINER_OUROBOROS_CONFIG)

        await self.exec_as_agent(
            environment,
            command=(
                'export BUN_INSTALL="$HOME/.bun"; '
                'export PATH="$BUN_INSTALL/bin:$PATH"; '
                "bun install && bun run --filter @ouroboros/cli build"
            ),
            cwd=CONTAINER_REPO_DIR,
            timeout_sec=900,
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        model = _env_or_none("OUROBOROS_TBENCH_MODEL")
        reasoning = _env_or_none("OUROBOROS_TBENCH_REASONING")
        max_steps = _env_or_default("OUROBOROS_TBENCH_MAX_STEPS", "50")

        env = {
            "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY", ""),
            "ANTHROPIC_API_KEY": os.environ.get("ANTHROPIC_API_KEY", ""),
            "OUROBOROS_OPENAI_COMPATIBLE_API_KEY": os.environ.get(
                "OUROBOROS_OPENAI_COMPATIBLE_API_KEY", ""
            ),
            "OUROBOROS_TBENCH_MODEL": model or "",
            "OUROBOROS_TBENCH_REASONING": reasoning or "",
            "OUROBOROS_TBENCH_MAX_STEPS": max_steps,
        }
        env = {key: value for key, value in env.items() if value}

        cli_options = [
            "--no-stream",
            "--no-rsi",
            "--max-steps",
            shlex.quote(max_steps),
        ]
        if model:
            cli_options.extend(["--model", shlex.quote(model)])
        if reasoning:
            cli_options.extend(["--reasoning-effort", shlex.quote(reasoning)])

        command = (
            "mkdir -p /logs/agent && "
            "if [ -f "
            f"{shlex.quote(CONTAINER_OUROBOROS_CONFIG)}"
            " ]; then "
            f"cp {shlex.quote(CONTAINER_OUROBOROS_CONFIG)} \"$HOME/.ouroboros\" && "
            "chmod 600 \"$HOME/.ouroboros\"; "
            "fi && "
            'export BUN_INSTALL="$HOME/.bun"; '
            'export PATH="$BUN_INSTALL/bin:$PATH"; '
            f"{shlex.quote(CONTAINER_REPO_DIR)}/packages/cli/dist/ouroboros "
            f"{' '.join(cli_options)} "
            f"-m {shlex.quote(instruction)} "
            f"> /logs/agent/{AGENT_STDOUT_NAME} "
            f"2> /logs/agent/{AGENT_STDERR_NAME}; "
            "status=$?; "
            f"cat /logs/agent/{AGENT_STDOUT_NAME} "
            f"/logs/agent/{AGENT_STDERR_NAME} > /logs/agent/{AGENT_LOG_NAME}; "
            "exit $status"
        )

        await self.exec_as_agent(
            environment,
            command=command,
            env=env,
            timeout_sec=int(_env_or_default("OUROBOROS_TBENCH_TIMEOUT_SEC", "3600")),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        log_path = self.logs_dir / AGENT_LOG_NAME
        stdout_path = self.logs_dir / AGENT_STDOUT_NAME
        stderr_path = self.logs_dir / AGENT_STDERR_NAME

        context.metadata = {
            "agent": self.name(),
            "model": _env_or_none("OUROBOROS_TBENCH_MODEL") or "from ~/.ouroboros",
            "reasoning_effort": _env_or_none("OUROBOROS_TBENCH_REASONING")
            or "from ~/.ouroboros/default",
            "max_steps": _env_or_default("OUROBOROS_TBENCH_MAX_STEPS", "50"),
            "uses_host_ouroboros_config": self._host_ouroboros_config_path().exists(),
            "log_path": str(log_path),
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "log_excerpt": self._read_excerpt(log_path),
            "stdout_excerpt": self._read_excerpt(stdout_path),
            "stderr_excerpt": self._read_excerpt(stderr_path),
        }

    def _prepare_repo_upload(self) -> Path:
        target = self.logs_dir / "repo-upload"
        if target.exists():
            shutil.rmtree(target)

        ignore = shutil.ignore_patterns(
            ".git",
            ".DS_Store",
            "node_modules",
            "dist",
            "out",
            "coverage",
            ".cache",
            ".turbo",
            "tmp",
            "logs",
            "*.log",
            ".ouroboros-transcripts.db",
        )
        shutil.copytree(REPO_ROOT, target, ignore=ignore)
        return target

    def _host_ouroboros_config_path(self) -> Path:
        configured_path = os.environ.get("OUROBOROS_TBENCH_CONFIG_PATH")
        if configured_path and configured_path.strip():
            return Path(configured_path).expanduser()
        return Path.home() / ".ouroboros"

    def _read_excerpt(self, path: Path, limit: int = 4000) -> str | None:
        if not path.exists():
            return None

        text = path.read_text(errors="replace")
        if len(text) <= limit:
            return text
        return text[:limit] + "\n...[truncated]"
