import { registerSalesActivity } from "./handlers-activity";
import { registerSalesCustomers } from "./handlers-customers";
import { registerSalesInsights } from "./handlers-insights";
import { registerSalesPipeline } from "./handlers-pipeline";
import { registerSalesReference } from "./handlers-reference";
import { registerSalesReports } from "./handlers-reports";

/* The sales mock API (docs/sales/api.md): every `/sales/…` route. */
export function registerSales() {
  registerSalesReference();
  registerSalesCustomers();
  registerSalesPipeline();
  registerSalesActivity();
  registerSalesInsights();
  registerSalesReports();
}
