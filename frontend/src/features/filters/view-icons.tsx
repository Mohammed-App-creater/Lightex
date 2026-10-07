import { Calendar, Filter, Flag, Star, UserRound, Zap, type LucideIcon } from "lucide-react";
import type { ViewIcon } from "@/lib/api/types";

export const VIEW_ICONS: { id: ViewIcon; name: string; Icon: LucideIcon }[] = [
  { id: "filter", name: "Filter", Icon: Filter },
  { id: "star", name: "Star", Icon: Star },
  { id: "user", name: "Person", Icon: UserRound },
  { id: "calendar", name: "Calendar", Icon: Calendar },
  { id: "bolt", name: "Bolt", Icon: Zap },
  { id: "flag", name: "Flag", Icon: Flag },
];

export function ViewGlyph({ icon, size = 16 }: { icon: ViewIcon; size?: number }) {
  const { Icon } = VIEW_ICONS.find((v) => v.id === icon) ?? VIEW_ICONS[0]!;
  return <Icon size={size} strokeWidth={1.6} aria-hidden />;
}
