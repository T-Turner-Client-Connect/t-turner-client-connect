"use client";

/** A "select all" box for a list of checkboxes with the same name in one form. */
export function CheckAll({ name, label = "Select all shown" }: { name: string; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm font-semibold text-navy-900">
      <input
        type="checkbox"
        className="size-4 accent-navy-900"
        onChange={(e) => {
          const form = e.currentTarget.form;
          if (!form) return;
          for (const el of Array.from(form.elements)) if (el instanceof HTMLInputElement && el.type === "checkbox" && el.name === name && !el.disabled) el.checked = e.currentTarget.checked;
        }}
      />
      {label}
    </label>
  );
}
