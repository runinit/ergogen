export type Vec3 = [number, number, number];
export type Dimension = number | string;
export type ObjectKind = 'key' | 'component' | 'mount' | 'anchor';
export interface Placement {
  ref?: string;
  at?: [Dimension, Dimension, Dimension];
  rotate?: Dimension;
  tilt?: Dimension;
  solve?: ('x' | 'y' | 'rotate')[];
  above?: string;
  below?: string;
  gap?: Dimension;
  override?: {at?: [Dimension, Dimension, Dimension]; rotate?: Dimension};
}
export interface Envelope {
  size?: [number, number]; radius?: number; height?: [number, number];
  at?: Vec3; rotate?: number; clearance?: number; polygon?: [number, number][];
}
export interface Finding {
  feature: string; sourcePath: string; code: string; message: string;
  severity: 'error' | 'warning'; location?: {line: number; col: number};
}
export interface ResolvedFrame {
  matrix: number[]; editMatrix: number[]; position: Vec3; motion: 'fixed' | 'floating';
  layer: string; motionGroup: string; assembly?: string;
}
export interface ResolvedObject extends ResolvedFrame {
  id: string; label: string; kind: ObjectKind; part?: string; revision?: string;
  cluster?: string; pcb?: string; side: 'top' | 'bottom'; locked: boolean;
  envelopes: Record<string, Envelope>; bounds: Record<string, [Vec3, Vec3]>;
  rotation: number; sourcePath: string; cell?: string[]; index?: number; properties?: Record<string, unknown>;
}
export interface ResolvedCluster extends ResolvedFrame {
  id: string; label: string; locked: boolean;
}
export interface LayoutGuide {
  id: string; label: string; position: Vec3; matrix: number[]; pcb?: string; members: string[]; axes: ('x' | 'y')[];
}
export interface LayoutReport {
  guides?: Record<string, LayoutGuide>;
  objects: Record<string, ResolvedObject>; clusters: Record<string, ResolvedCluster>;
  layers: Record<string, ResolvedFrame>; findings: Finding[];
  units: Record<string, number>;
  constraints?: {status: 'solved' | 'underconstrained'; dof: number;
    dimensions: Record<string, LayoutConstraint & {actual: number; residual: number}>; redundant: string[]};
}
export interface LayoutConstraint {
  type: 'aligned' | 'coincident' | 'horizontal' | 'vertical' | 'distance' | 'angle' | 'equal_spacing' | 'symmetric';
  refs: string[]; value?: Dimension; axis?: 'x' | 'y'; label?: string;
}
export interface NativeObject {
  kind: ObjectKind; label?: string; part?: string; cluster?: string; layer?: string;
  placement?: Placement; locked?: boolean; pcb?: string;
}
export interface NativeDocument {
  schema: 'ergogen/v1'; meta?: Record<string, unknown>; units?: Record<string, Dimension>;
  parts?: Record<string, unknown>;
  layout: {objects?: Record<string, NativeObject>; clusters?: Record<string, unknown>; layers?: Record<string, unknown>; constraints?: Record<string, LayoutConstraint>};
  designs?: Record<string, unknown>; pcbs?: Record<string, unknown>;
}
export function process(input: string | NativeDocument, options?: Record<string, unknown>, logger?: (message: string) => void): Promise<{layout: LayoutReport; [key: string]: unknown}>;
export function inject(type: string, name: string, value: unknown): void;
export const version: string;
export const footprints: Record<string, (...args: any[]) => any>;
