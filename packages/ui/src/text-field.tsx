import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string | undefined;
  hint?: ReactNode | undefined;
  label: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { className = "", error, hint, id, label, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = error || hint ? `${inputId}-description` : undefined;

  return (
    <label className={`ui-field ${className}`.trim()} htmlFor={inputId}>
      <span className="ui-field__label">{label}</span>
      <input
        aria-describedby={descriptionId}
        aria-invalid={Boolean(error)}
        className="ui-field__input"
        id={inputId}
        ref={ref}
        {...props}
      />
      {error ? (
        <span className="ui-field__error" id={descriptionId}>
          {error}
        </span>
      ) : hint ? (
        <span className="ui-field__hint" id={descriptionId}>
          {hint}
        </span>
      ) : null}
    </label>
  );
});
