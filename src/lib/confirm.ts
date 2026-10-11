/** Native confirm() guard for consequential client actions. No modal library needed. */
export function confirmed(message: string): boolean {
  return typeof window !== "undefined" ? window.confirm(message) : true;
}
