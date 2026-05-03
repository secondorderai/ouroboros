import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const TEST_RUNTIME_DIR = process.env.OUROBOROS_TEST_RUNTIME_DIR ?? join(tmpdir(), 'ouroboros-desktop-tests')
export const TEST_SCENARIO_PATH = process.env.OUROBOROS_TEST_SCENARIO_PATH ?? join(TEST_RUNTIME_DIR, 'scenario.json')
export const TEST_DIALOG_RESPONSES_PATH = process.env.OUROBOROS_TEST_DIALOG_RESPONSES_PATH ?? join(TEST_RUNTIME_DIR, 'dialog-responses.json')
export const TEST_POLICY_RESPONSES_PATH = process.env.OUROBOROS_TEST_POLICY_RESPONSES_PATH ?? join(TEST_RUNTIME_DIR, 'policy-responses.json')
export const TEST_STATE_PATH = process.env.OUROBOROS_TEST_STATE_PATH ?? join(TEST_RUNTIME_DIR, 'mock-state.json')
export const TEST_MOCK_LOG_PATH = process.env.OUROBOROS_TEST_MOCK_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'mock-cli.log')
export const TEST_INSTALL_UPDATE_LOG_PATH = process.env.OUROBOROS_TEST_INSTALL_UPDATE_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'install-update.log')
export const TEST_EXTERNAL_URL_LOG_PATH = process.env.OUROBOROS_TEST_EXTERNAL_URL_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'external-url.log')
export const TEST_OPEN_ARTIFACT_LOG_PATH = process.env.OUROBOROS_TEST_OPEN_ARTIFACT_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'open-artifact.log')
export const TEST_SAVE_ARTIFACT_LOG_PATH = process.env.OUROBOROS_TEST_SAVE_ARTIFACT_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'save-artifact.log')
export const TEST_BOOT_LOG_PATH = process.env.OUROBOROS_TEST_BOOT_LOG_PATH ?? join(TEST_RUNTIME_DIR, 'boot.log')
export const TEST_USER_DATA_DIR = process.env.OUROBOROS_TEST_USER_DATA_DIR ?? join(TEST_RUNTIME_DIR, 'user-data')
export const TEST_UPDATE_DOWNLOADED_PATH = process.env.OUROBOROS_TEST_UPDATE_DOWNLOADED_PATH ?? join(TEST_RUNTIME_DIR, 'update-downloaded.txt')
