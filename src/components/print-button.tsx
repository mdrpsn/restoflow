"use client";

export function PrintButton() {
  return (
    <button type="button" className="btn-secondary mt-3" onClick={() => window.print()}>
      Print all
    </button>
  );
}
