export type TransformOrientation = "world" | "object";

/** The proxy's basis supplies the selected axes even for Three's scale tool,
 * which always uses the attached object's local orientation internally. */
export function transformSpace(_mode: string, components = false, orientation: TransformOrientation = "world"): "world" | "local" {
  return !components && orientation === "object" ? "local" : "world";
}
