import type { Joint } from "./skeleton";
export type Elasticity = { stretch: number; spacing: number; expansion: number; budget: number; density?: number; distribution?: number; joints: string[] | null };
export const elasticityDefaults = { stretch: 1, spacing: 1.5, expansion: 1, budget: 10000, density: 1, distribution: 0 };
export function elasticEdges(bound: string[], joints: Joint[], scope: string[] | null) {
 const allowed = new Set(scope ?? bound), binding = new Set(bound);
 return joints.filter(j => j.parentId && binding.has(j.id) && binding.has(j.parentId) && allowed.has(j.id) && allowed.has(j.parentId)).map(j => [j.parentId!, j.id] as [string,string]);
}
export function validateElasticity(value: unknown): asserts value is Elasticity {
 const e = value as Elasticity;
 if (e && ((e.density !== undefined && (!Number.isFinite(e.density) || e.density < 0 || e.density > 8)) || (e.distribution !== undefined && (!Number.isFinite(e.distribution) || e.distribution < 0 || e.distribution > 1)))) throw Error("Invalid Elasticity density or distribution.");
 if (!e || !Number.isFinite(e.stretch) || e.stretch < 0 || e.stretch > 4 || !Number.isFinite(e.expansion) || e.expansion < 0 || e.expansion > 4 || !Number.isFinite(e.spacing) || e.spacing < 1.05 || e.spacing > 10 || !Number.isInteger(e.budget) || e.budget < 0 || e.budget > 100000 || (e.joints !== null && (!Array.isArray(e.joints) || e.joints.length > 256 || !e.joints.every(j=>typeof j === "string") || new Set(e.joints).size !== e.joints.length))) throw Error("Invalid Elasticity attributes.");
}
