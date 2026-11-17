/** A form control plus an optional red error message rendered below it. */
export function Field({ error, children }: { error?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      {children}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
