import type { MetrivioDb } from '@metrivio/core';
import { ContentRecommendationEngine, type ContentRecommendation } from './content-recommendation-engine.js';

/**
 * Stage 9, Section N — a deterministic weekly planning output, purely a
 * ranked presentation of `ContentRecommendationEngine`'s own output
 * (Section N: "Then: Priority 2, Priority 3, etc." — an ordering
 * concern, not a new scoring system). Never publishes anything itself —
 * this produces a plan for a human to act on (Section N: "Do not
 * automatically publish").
 */
export interface WeeklyContentPlan {
  generatedAt: string;
  priorities: ContentRecommendation[];
}

const DEFAULT_MAX_PRIORITIES = 5;

export class WeeklyContentPlanService {
  private readonly recommendations: ContentRecommendationEngine;

  constructor(private readonly db: MetrivioDb) {
    this.recommendations = new ContentRecommendationEngine(db);
  }

  async buildPlan(maxPriorities: number = DEFAULT_MAX_PRIORITIES, now: string = new Date().toISOString()): Promise<WeeklyContentPlan> {
    const ranked = await this.recommendations.generateRecommendations();
    return { generatedAt: now, priorities: ranked.slice(0, maxPriorities) };
  }
}

export function renderWeeklyContentPlanMarkdown(plan: WeeklyContentPlan): string {
  if (plan.priorities.length === 0) {
    return `# Weekly Content Plan (${plan.generatedAt})\n\nNo content opportunities are currently available to prioritize.`;
  }

  const lines: string[] = [`# Weekly Content Plan (${plan.generatedAt})`, ''];
  plan.priorities.forEach((rec, index) => {
    const label = index === 0 ? 'TOP PRIORITY' : `Priority ${index + 1}`;
    lines.push(`## ${label}: ${rec.what}`, '');
    lines.push(`1. Topic: ${rec.what}`);
    lines.push(`2. Why now: ${rec.why}`);
    lines.push(`3. Evidence: ${rec.evidence.join('; ')}`);
    lines.push(`4. ICP: ${rec.icp}`);
    lines.push(`5. Recommended format: ${rec.format}`);
    lines.push(`6. Hook direction: ${rec.hookDirection}`);
    lines.push(`7. Expected purpose: ${rec.expectedPurpose}`);
    lines.push(`8. Score: ${rec.score}`);
    lines.push('');
  });
  return lines.join('\n');
}
