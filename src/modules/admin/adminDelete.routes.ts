import { Router } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ok } from "../../utils/respond.js";
import { objectId } from "../../utils/zodCommon.js";
import { deleteCustomer, deleteHandler, deleteVendor } from "./accountDeletion.service.js";

// Permanent deletes, for the Super Admin only. Mounted under /api/admin, behind requireRole("ADMIN"). The other admin
// routers for the same paths have no DELETE, so these sit beside them. Admin accounts cannot be deleted from here at all.
export const adminDeleteRouter = Router();

const params = validate({ params: z.object({ id: objectId }) });

adminDeleteRouter.delete(
  "/customers/:id",
  params,
  asyncHandler(async (req, res) => ok(res, await deleteCustomer(req.validated.params.id))),
);

adminDeleteRouter.delete(
  "/vendors/:id",
  params,
  asyncHandler(async (req, res) => ok(res, await deleteVendor(req.validated.params.id))),
);

adminDeleteRouter.delete(
  "/staff/:id",
  params,
  asyncHandler(async (req, res) => ok(res, await deleteHandler(req.validated.params.id))),
);
