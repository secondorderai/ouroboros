import { describe, it, expect } from 'bun:test';

// Simulated implementation of the skill's core logic for testing
interface SubAgentConfig {
  id: string;
  allowedTools: string[];
  maxIterations: number;
  timeoutMs: number;
}

interface SubAgentResult {
  status: 'success' | 'partial' | 'failed';
  summary: string;
  artifacts: string[];
  requires_parent_action: boolean;
}

class SubAgentOrchestrator {
  async execute(config: SubAgentConfig, simulateWork: (tools: string[]) => Promise<Partial<SubAgentResult>>) {
    if (config.maxIterations < 1) throw new Error('Invalid iteration limit');

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Execution timeout')), config.timeoutMs)
    );

    try {
      const workPromise = simulateWork(config.allowedTools);
      const result = await Promise.race([workPromise, timeoutPromise]);
      return { status: 'success', ...result } as SubAgentResult;
    } catch (err) {
      if ((err as Error).message === 'Execution timeout') {
        return { status: 'partial', summary: 'Terminated due to timeout', artifacts: [], requires_parent_action: true };
      }
      return { status: 'failed', summary: (err as Error).message, artifacts: [], requires_parent_action: false };
    }
  }
}

// Helper to validate tool scoping
function validateToolScope(availableTools: string[], requestedTools: string[]): string[] {
  return requestedTools.filter(t => availableTools.includes(t));
}

describe('sub-agent-delegation', () => {
  const orchestrator = new SubAgentOrchestrator();

  it('successfully delegates task with scoped tools and returns summarized output', async () => {
    const config: SubAgentConfig = {
      id: 'task-1',
      allowedTools: ['csv_parser', 'data_cleaner'],
      maxIterations: 3,
      timeoutMs: 1000
    };

    const mockWork = async (tools: string[]) => {
      expect(tools).toEqual(['csv_parser', 'data_cleaner']);
      return {
        summary: 'Processed 500 rows, removed 12 outliers.',
        artifacts: ['/output/cleaned.csv'],
        requires_parent_action: false
      };
    };

    const result = await orchestrator.execute(config, mockWork);

    expect(result.status).toBe('success');
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.requires_parent_action).toBe(false);
    expect(result.artifacts).toContain('/output/cleaned.csv');
  });

  it('handles timeout gracefully and returns partial status', async () => {
    const config: SubAgentConfig = {
      id: 'task-2',
      allowedTools: ['slow_api'],
      maxIterations: 5,
      timeoutMs: 50 // Very short to trigger timeout
    };

    const mockSlowWork = async () => {
      await new Promise(r => setTimeout(r, 200)); // Exceeds timeout
      return { summary: 'Done', artifacts: [], requires_parent_action: false };
    };

    const result = await orchestrator.execute(config, mockSlowWork);

    expect(result.status).toBe('partial');
    expect(result.summary).toContain('timeout');
    expect(result.requires_parent_action).toBe(true);
  });

  it('enforces strict tool scoping by filtering unauthorized tools', () => {
    const parentAvailable = ['read_db', 'write_db', 'send_email', 'run_shell'];
    const subAgentRequested = ['read_db', 'send_email', 'run_shell', 'delete_records'];

    const scopedTools = validateToolScope(parentAvailable, subAgentRequested);

    expect(scopedTools).toContain('read_db');
    expect(scopedTools).toContain('send_email');
    expect(scopedTools).toContain('run_shell');
    expect(scopedTools).not.toContain('delete_records');
    expect(scopedTools.length).toBe(3);
  });

  it('rejects invalid configuration with zero or negative iterations', async () => {
    const config: SubAgentConfig = {
      id: 'task-3',
      allowedTools: ['data_parser'],
      maxIterations: 0,
      timeoutMs: 1000
    };

    await expect(orchestrator.execute(config, async () => ({}))).rejects.toThrow('Invalid iteration limit');
  });
});