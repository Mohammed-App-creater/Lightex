"use client";

import { Badge } from "@/ui/badge";
import { Tabs } from "@/ui/tabs";
import { useCan } from "@/platform/roles/can";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { CalendarSettings } from "./calendar-settings";
import { GeneralSettings } from "./general-settings";
import { LostReasonsSettings, ProductsSettings } from "./reference-lists";
import { StagesSettings } from "./stages-settings";
import { useQueryParam } from "./use-query-param";

const TABS = [
  { value: "general", label: "General" },
  { value: "stages", label: "Stages" },
  { value: "products", label: "Products" },
  { value: "lost-reasons", label: "Lost reasons" },
  { value: "calendar", label: "Calendar" },
] as const;
type Tab = (typeof TABS)[number]["value"];
const isTab = (v: string): v is Tab => TABS.some((t) => t.value === v);

/**
 * Sales settings (docs/sales/api.md §5): thresholds, stages, products, lost reasons, working calendar and holidays.
 * Every sales member can read them (`sales.dashboard.view`); writes need `sales.settings.manage`, read-only otherwise.
 */
export function SalesSettingsScreen() {
  const canManage = useCan("sales.settings.manage");
  const [raw, setTab] = useQueryParam("tab", "general");
  const tab: Tab = isTab(raw) ? raw : "general";
  return (
    <SalesGate permission="sales.dashboard.view" name="Sales settings">
      <SalesPageFrame title="Sales settings" actions={!canManage && <Badge>Read-only</Badge>}>
        <Tabs label="Settings sections" value={tab} onChange={setTab} items={[...TABS]} className="max-w-full overflow-x-auto" />
        {tab === "general" && <GeneralSettings canManage={canManage} />}
        {tab === "stages" && <StagesSettings canManage={canManage} />}
        {tab === "products" && <ProductsSettings canManage={canManage} />}
        {tab === "lost-reasons" && <LostReasonsSettings canManage={canManage} />}
        {tab === "calendar" && <CalendarSettings canManage={canManage} />}
      </SalesPageFrame>
    </SalesGate>
  );
}
