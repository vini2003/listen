import type { Person } from "../../domain/models";
import { getInitials } from "../../lib/format";

interface AvatarProps {
  person?: Person | null;
  label?: string;
  color?: string;
  size?: "small" | "medium" | "large";
}

export function Avatar({ person, label = "Unknown", color = "#8a8a85", size = "medium" }: AvatarProps) {
  const displayName = person?.fullName || label;

  if (person?.photoDataUrl) {
    return (
      <img
        className={`avatar avatar-${size}`}
        src={person.photoDataUrl}
        alt={displayName}
      />
    );
  }

  return (
    <span
      className={`avatar avatar-${size}`}
      style={{ backgroundColor: person?.color || color }}
      aria-label={displayName}
    >
      {getInitials(displayName) || "?"}
    </span>
  );
}
