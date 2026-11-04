// What a back-office account may open. Pure and unit tested; the routes and the screens both read from this list.
//
// A "super admin" is an administrator with no staff title: they can do everything. A staff member (operations manager,
// finance manager and so on) is an administrator account with a title and a list of permissions the super admin chose.

export const PERMISSIONS = ["overview", "orders", "deliveries", "handlers", "vendors", "customers", "payouts", "catalog", "settings"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, { label: string; hint: string }> = {
  overview: { label: "Overview", hint: "The dashboard with sales, commission and what needs attention" },
  orders: { label: "Orders", hint: "See orders and resolve the ones that need attention" },
  deliveries: { label: "Deliveries", hint: "Assign delivery handlers and move deliveries along" },
  handlers: { label: "Delivery handlers", hint: "Create and switch off delivery handler accounts" },
  vendors: { label: "Vendors", hint: "Review, approve, suspend, message and create stores" },
  customers: { label: "Customers", hint: "See customers and switch their accounts on or off" },
  payouts: { label: "Payouts", hint: "Pay vendors and decline payout requests" },
  catalog: { label: "Categories and banners", hint: "Manage product categories and the home page banners" },
  settings: { label: "Pricing and rules", hint: "Price per km, commission, cities and vendor rules" },
};

export const STAFF_TITLES = ["OPERATIONS_MANAGER", "VENDOR_MANAGER", "PRODUCT_MANAGER", "LOGISTICS_MANAGER", "FINANCE_MANAGER", "CUSTOMER_SUPPORT"] as const;
export type StaffTitle = (typeof STAFF_TITLES)[number];

/** What each title starts with when the super admin creates the account. They can tick or untick any of it. */
export const STAFF_TITLE_INFO: Record<StaffTitle, { label: string; defaults: Permission[] }> = {
  OPERATIONS_MANAGER: { label: "Operations manager", defaults: ["overview", "orders", "deliveries", "handlers", "vendors", "customers"] },
  VENDOR_MANAGER: { label: "Vendor manager", defaults: ["overview", "vendors", "handlers"] },
  PRODUCT_MANAGER: { label: "Product manager", defaults: ["overview", "catalog", "handlers"] },
  LOGISTICS_MANAGER: { label: "Logistics manager", defaults: ["overview", "orders", "deliveries", "handlers"] },
  FINANCE_MANAGER: { label: "Finance manager", defaults: ["overview", "orders", "payouts", "handlers"] },
  CUSTOMER_SUPPORT: { label: "Customer support", defaults: ["orders", "customers"] },
};

interface HasStaffAccess {
  role: string;
  staffTitle?: string | null;
  permissions?: string[] | null;
}

/** An administrator with no staff title. */
export const isSuperAdmin = (u: HasStaffAccess) => u.role === "ADMIN" && !u.staffTitle;

export function hasPermission(u: HasStaffAccess, permission: Permission): boolean {
  if (u.role !== "ADMIN") return false;
  if (isSuperAdmin(u)) return true;
  return Boolean(u.permissions?.includes(permission));
}

export const hasAnyPermission = (u: HasStaffAccess, permissions: readonly Permission[]) => permissions.some((p) => hasPermission(u, p));

/** Keeps only known permissions, once each, in the standard order. */
export function cleanPermissions(list: readonly string[]): Permission[] {
  return PERMISSIONS.filter((p) => list.includes(p));
}
