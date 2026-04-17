import { describe, it, expect } from 'bun:test';

// Mock implementations reflecting the skill's core logic
type Thresholds = { warn: number; flush: number; compact: number };
type ContextConfig = { budget: number; thresholds: Thresholds; retention: number };
type ContextBlock = { id: string; content: string; weight: number; tokens: number };

function estimateTokens(blocks: ContextBlock[]): number {
  return blocks.reduce((sum, b) => sum + b.tokens, 0);
}

function evaluateThreshold(usage: number, budget: number, thresholds: Thresholds): 'idle' | 'warn' | 'flush' | 'compact' {
  const ratio = usage / budget;
  if (ratio >= thresholds.compact) return 'compact';
  if (ratio >= thresholds.flush) return 'flush';
  if (ratio >= thresholds.warn) return 'warn';
  return 'idle';
}

function createCheckpoint(blocks: ContextBlock[]): Record<string, unknown> {
  return { 
    type: 'state_checkpoint', 
    extracted_insights: blocks.slice(0, 3).map(b => b.content), 
    timestamp: Date.now() 
  };
}

function greedyTrim(blocks: ContextBlock[], budget: number, retentionRatio: number): ContextBlock[] {
  const targetBudget = budget * retentionRatio;
  let currentTokens = 0;
  const sorted = [...blocks].sort((a, b) => b.weight - a.weight || b.id.localeCompare(a.id));
  const preserved: ContextBlock[] = [];

  for (const block of sorted) {
    if (currentTokens + block.tokens <= targetBudget) {
      preserved.push(block);
      currentTokens += block.tokens;
    }
  }
  return preserved.sort((a, b) => a.id.localeCompare(b.id));
}

function emergencyRecovery(blocks: ContextBlock[], budget: number): { payload: ContextBlock[]; retryCap: number } {
  const compacted = blocks.slice(-3);
  return { payload: compacted, retryCap: 2 };
}

describe('proactive-context-management logic', () => {
  const config: ContextConfig = {
    budget: 10000,
    thresholds: { warn: 0.75, flush: 0.85, compact: 0.95 },
    retention: 0.4
  };

  const generateBlocks = (count: number, baseTokens: number): ContextBlock[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg_${i}`,
      content: `Content ${i}`,
      weight: Math.random(),
      tokens: baseTokens
    }));

  it('should trigger compact action when usage exceeds compact threshold', () => {
    const blocks = generateBlocks(15, 700);
    const totalTokens = estimateTokens(blocks);
    const action = evaluateThreshold(totalTokens, config.budget, config.thresholds);
    expect(action).toBe('compact');
    expect(totalTokens).toBeGreaterThan(config.budget * config.thresholds.compact);
  });

  it('should externalize state before trimming and preserve high-weight semantic blocks', () => {
    const blocks = generateBlocks(20, 400);
    blocks[5].weight = 0.95;
    blocks[12].weight = 0.98;
    blocks[18].weight = 0.92;

    const checkpoint = createCheckpoint(blocks);
    expect(checkpoint).toHaveProperty('type', 'state_checkpoint');
    expect(Array.isArray(checkpoint.extracted_insights)).toBe(true);

    const trimmed = greedyTrim(blocks, config.budget, config.retention);
    const targetBudget = config.budget * config.retention;
    const actualUsage = trimmed.reduce((s, b) => s + b.tokens, 0);

    expect(actualUsage).toBeLessThanOrEqual(targetBudget);
    const preservedIds = new Set(trimmed.map(b => b.id));
    expect(preservedIds.has('msg_12')).toBe(true);
    expect(preservedIds.has('msg_5')).toBe(true);
  });

  it('should handle emergency recovery when budget is exceeded and limit retries', () => {
    const blocks = generateBlocks(50, 300);
    const recovery = emergencyRecovery(blocks, config.budget);

    expect(recovery.payload.length).toBe(3);
    expect(recovery.retryCap).toBe(2);
    expect(recovery.payload[0].id).toBe('msg_47');
  });

  it('should remain idle when usage is below warn threshold', () => {
    const blocks = generateBlocks(5, 400);
    const totalTokens = estimateTokens(blocks);
    const action = evaluateThreshold(totalTokens, config.budget, config.thresholds);
    expect(action).toBe('idle');
  });
});