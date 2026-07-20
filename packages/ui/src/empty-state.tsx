import type { ReactNode } from "react";

export interface EmptyStateProps {
  action?: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}

export function EmptyState({ action, description, icon, title }: EmptyStateProps) {
  return (
    <div className="ui-empty-state">
      <div aria-hidden="true" className="ui-empty-state__icon">
        {icon}
      </div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}
