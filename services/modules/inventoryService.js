import mongoose from "mongoose";
import Inventory from "../../models/modules/inventory.js";
import Registry from "../../models/modules/Registry.js";
import { createAppError } from "../../utils/errorHandler.js";
import MetalStock from "../../models/modules/MetalStock.js";
import InventoryLog from "../../models/modules/InventoryLog.js";

class InventoryService {
  static async fetchAllInventory() {
    try {
      const logs = await InventoryLog.aggregate([
        // Sort to ensure latest values
        { $sort: { updatedAt: -1 } },

        // Group by stockCode
        {
          $group: {
            _id: "$stockCode",
            totalGrossWeight: {
              $sum: {
                $switch: {
                  branches: [
                    { case: { $eq: ["$transactionType", "sale"] }, then: { $multiply: ["$grossWeight", -1] } },
                    { case: { $eq: ["$transactionType", "metalPayment"] }, then: { $multiply: ["$grossWeight", -1] } },
                    { case: { $eq: ["$transactionType", "purchaseReturn"] }, then: { $multiply: ["$grossWeight", -1] } },
                    { case: { $eq: ["$transactionType", "saleReturn"] }, then: "$grossWeight" },
                    { case: { $eq: ["$transactionType", "purchase"] }, then: "$grossWeight" },
                    { case: { $eq: ["$transactionType", "metalReceipt"] }, then: "$grossWeight" },
                    { case: { $eq: ["$transactionType", "opening"] }, then: "$grossWeight" }
                  ],
                  default: 0
                }
              }
            },
            pcs: { $first: "$pcs" },
            code: { $first: "$code" }
          }
        },

        // Lookup stock details from metalstocks
        {
          $lookup: {
            from: "metalstocks",
            localField: "_id",
            foreignField: "_id",
            as: "stock"
          }
        },
        { $unwind: { path: "$stock", preserveNullAndEmptyArrays: true } },

        // Lookup karat purity from karatmasters
        {
          $lookup: {
            from: "karatmasters",
            localField: "stock.karat",
            foreignField: "_id",
            as: "karatInfo"
          }
        },
        { $unwind: { path: "$karatInfo", preserveNullAndEmptyArrays: true } },

        // Lookup metalType from divisionmasters
        {
          $lookup: {
            from: "divisionmasters",
            localField: "stock.metalType",
            foreignField: "_id",
            as: "metalTypeInfo"
          }
        },
        { $unwind: { path: "$metalTypeInfo", preserveNullAndEmptyArrays: true } },

        // Final projection
        {
          $project: {
            _id: 0,
            totalGrossWeight: 1,
            code: 1,
            totalValue: "$stock.totalValue",
            metalId: "$stock._id",
            StockName: "$stock.code",
            pcs: "$stock.pcs",
            purity: "$karatInfo.standardPurity",
            metalType: "$metalTypeInfo.description"
          }
        }
      ]);

      return logs;
    } catch (err) {
      throw createAppError(
        "Failed to fetch inventory logs",
        500,
        "FETCH_ERROR"
      );
    }
  }

  static async reverseInventory(transaction, session) {
    try {
      for (const item of transaction.stockItems || []) {
        const metalId = item.stockCode?._id;
        if (!metalId) continue;

        const [inventory, metal] = await Promise.all([
          Inventory.findOne({ metal: new mongoose.Types.ObjectId(metalId) }).session(session),
          MetalStock.findById(metalId).session(session),
        ]);

        if (!inventory) {
          throw createAppError(
            `Inventory not found for metal: ${item.stockCode.code}`,
            404,
            "INVENTORY_NOT_FOUND"
          );
        }

        const isSale = transaction.transactionType === "sale" || transaction.transactionType === "metalPayment";
        const factor = isSale ? 1 : -1; // Reverse the factor
        const pcsDelta = factor * (item.pieces || 0);
        const weightDelta = factor * (item.grossWeight || 0);
        inventory.pcsCount += pcsDelta;
        inventory.grossWeight += weightDelta;
        inventory.pureWeight = (inventory.grossWeight * inventory.purity) / 100;
        await inventory.save({ session });
        // Inventory Log
        await InventoryLog.create([{
          code: metal.code,
          stockCode: metal._id,
          voucherCode: transaction.voucherNumber || item.voucherNumber || '',
          voucherDate: transaction.voucherDate || item.voucherDate || '',
          transactionType: transaction.transactionType,
          pcs: item.pieces || 0,
          grossWeight: item.grossWeight || 0,
          pureWeight: (item.grossWeight * item.purity) / 100,
          action: isSale ? "remove" : "add",
          createdAt: new Date(),
        }], { session });
      }
    } catch (error) {
      if (error.name === "AppError") throw error;
      throw createAppError(
        error.message || "Failed to reverse inventory",
        500,
        "INVENTORY_REVERSE_FAILED"
      );
    }
  }
  static async fetchInvLogs() {
    try {
      const logs = await InventoryLog.find().sort({ createdAt: -1 });
      return logs
    } catch (error) {
      throw createAppError(
        "Failed to fetch inventory Logs",
        500,
        "FETCH_INVENTORY_LOG_ERROR"
      );
    }
  }

  static async fetchInventoryById(inventoryId) {
    try {
      const logs = await InventoryLog.aggregate([
        // 🎯 Step 1: Match only logs for that stockId
        {
          $match: {
            stockCode: new mongoose.Types.ObjectId(inventoryId) // or just stockId if it's already ObjectId
          }
        },

        // 📌 Step 2: Sort (optional but helpful)
        { $sort: { createdAt: -1 } },

        // 📌 Step 3: Group by stockCode
        {
          $group: {
            _id: "$stockCode",
            totalGrossWeight: {
              $sum: {
                $switch: {
                  branches: [
                    { case: { $eq: ["$transactionType", "sale"] }, then: { $multiply: ["$grossWeight", -1] } },
                    { case: { $eq: ["$transactionType", "purchaseReturn"] }, then: { $multiply: ["$grossWeight", -1] } },
                    { case: { $eq: ["$transactionType", "saleReturn"] }, then: "$grossWeight" },
                    { case: { $eq: ["$transactionType", "purchase"] }, then: "$grossWeight" },
                    { case: { $eq: ["$transactionType", "opening"] }, then: "$grossWeight" }
                  ],
                  default: 0
                }
              }
            },
            pcs: { $sum: "$pcs" },
            code: { $first: "$code" }
          }
        },

        // 📌 Step 4: Lookup metal stock
        {
          $lookup: {
            from: "metalstocks",
            localField: "_id",
            foreignField: "_id",
            as: "stock"
          }
        },
        { $unwind: { path: "$stock", preserveNullAndEmptyArrays: true } },

        // 📌 Step 5: Lookup Karat info
        {
          $lookup: {
            from: "karatmasters",
            localField: "stock.karat",
            foreignField: "_id",
            as: "karatInfo"
          }
        },
        { $unwind: { path: "$karatInfo", preserveNullAndEmptyArrays: true } },

        // 📌 Step 6: Lookup Metal Type
        {
          $lookup: {
            from: "divisionmasters",
            localField: "stock.metalType",
            foreignField: "_id",
            as: "metalTypeInfo"
          }
        },
        { $unwind: { path: "$metalTypeInfo", preserveNullAndEmptyArrays: true } },

        // 📌 Step 7: Final Projection
        {
          $project: {
            _id: 0,
            totalGrossWeight: 1,
            code: 1,
            totalValue: "$stock.totalValue",
            metalId: "$stock._id",
            StockName: "$stock.code",
            pcs: 1,
            purity: "$karatInfo.standardPurity",
            karatDescription: "$karatInfo.description",
            karatCode: "$karatInfo.karatCode",
            metalType: "$metalTypeInfo.description"
          }
        }
      ]);

      return logs?.[0] || null;


    } catch (err) {
      throw createAppError(
        "Failed to fetch inventory",
        500,
        "FETCH_SINGLE_ERROR"
      );
    }
  }

  static async addInitialInventory(metal, createdBy) {
    try {
      // 1. Create inventory entry
      const inventory = new Inventory({
        metal: metal._id,
        pcs: metal.pcs,
        pcsCount: 0,
        pcsValue: metal.totalValue,
        grossWeight: 0,
        pureWeight: 0,
        purity: metal.karat?.standardPurity || 0,
        status: "active",
        isActive: true,
        createdBy,
      });

      const savedInventory = await inventory.save();

      // 2. Add inventory log
      await InventoryLog.create({
        code: metal.code,
        pcs: metal.pcs,
        stockCode: metal._id,
        voucherCode: metal.voucherCode || 'INITIAL',
        voucherDate: metal.voucherDate || new Date(),
        grossWeight: 0,
        action: 'add',
        transactionType: 'initial',
        createdBy: createdBy,
        note: 'Initial inventory record created',
      });

      return savedInventory;

    } catch (error) {
      throw createAppError(
        "Error while saving to database",
        500,
        "DATABASE_ERROR"
      );
    }
  }


  static async updateInventoryByFrontendInput({
    metalId,
    type,
    value,
    adminId,
    voucher,
    goldBidPrice,
  }) {
    try {
      if (!metalId || !type || value === undefined) {
        throw createAppError(
          "Missing metalId, type, or value",
          400,
          "MISSING_INPUT"
        );
      }

      const inventory = await Inventory.findOne({
        metal: new mongoose.Types.ObjectId(metalId),
      });

      if (!inventory) {
        throw createAppError(
          `Inventory not found for metal ID: ${metalId}`,
          404,
          "INVENTORY_NOT_FOUND"
        );
      }
      const metal = await MetalStock.findById(metalId);
      if (!metal) {
        throw createAppError(
          `Metal not found for ID: ${metalId}`,
          404,
          "METAL_NOT_FOUND"
        );
      }

      const qty = Number(value);
      if (isNaN(qty)) {
        throw createAppError(
          "Provided value must be a number",
          400,
          "INVALID_VALUE"
        );
      }
      let description = "";
      let registryValue = 0;
      const isAddition = qty > 0;

      if (type === "pcs") {
        if (!Number.isInteger(qty) || qty < 0) {
          throw createAppError(
            "Piece count is required and must be a non-negative integer for piece-based stock",
            400,
            "INVALID_PCS_COUNT"
          );
        }
        inventory.grossWeight += qty * metal.totalValue;
        inventory.pcsCount += qty;
        description = `Inventory ${isAddition ? "added" : "removed"}: ${metal.code
          } - ${Math.abs(qty)} pieces & ${metal.totalValue} grams`;
        registryValue = Math.abs(qty) * (metal.pricePerPiece || 0);
      } else if (type === "grams") {
        if (qty < 0) {
          throw createAppError(
            "Weight value must be a non-negative number",
            400,
            "INVALID_GRAM_VALUE"
          );
        }
        inventory.grossWeight += qty;
        inventory.pcsCount = inventory.grossWeight / inventory.pcsValue;
        inventory.pureWeight = (inventory.grossWeight * inventory.purity) / 100;
        description = `Inventory ${isAddition ? "added" : "removed"}: ${metal.code
          } - ${Math.abs(qty)} grams`;
        registryValue = Math.abs(qty) * (metal.pricePerGram || 0);
      } else {
        throw createAppError(
          "Invalid type. Use 'pcs' or 'grams'",
          400,
          "INVALID_TYPE"
        );
      }
      const savedInventory = await inventory.save();
      let pureWeight;

      if (type == "pcs") {
        value = savedInventory.pcsValue * value;
        pureWeight = value * savedInventory.purity;
      } else {
        pureWeight = value * savedInventory.purity;
      }


      const invLog = await InventoryLog.create({
        code: metal.code,
        transactionType: "opening",
        pcs: type === "pcs",
        stockCode: metal._id,
        voucherCode: voucher?.voucherCode || "",
        voucherType: voucher?.voucherType || "",
        voucherDate: voucher?.voucherDate || new Date(),
        grossWeight: value,
        action: isAddition ? "add" : "remove",
        createdBy: adminId,
        note: `Inventory ${isAddition ? "added" : "removed"} by admin.`,
      });


      await this.createRegistryEntry({
        transactionId: await Registry.generateTransactionId(),
        metalId: metalId, // this is not Transaction id this is MetalID
        InventoryLogID: invLog._id,
        type: "GOLD_STOCK",
        goldBidValue: goldBidPrice,
        description: `OPENING STOCK FOR ${metal.code}`,
        value: value,
        isBullion: true,
        credit: value,
        reference: voucher.voucherCode,
        createdBy: adminId,
        purity: inventory.purity,
        grossWeight: value,
        pureWeight,
      });
      return savedInventory;
    } catch (error) {
      if (error.name === "AppError") throw error;
      throw createAppError(
        error.message || "Inventory update failed",
        500,
        "INVENTORY_UPDATE_ERROR"
      );
    }
  }

  static async updateInventory(transaction, isSale, admin) {
    try {
      const updated = [];

      for (const item of transaction.stockItems || []) {
        const metalId = item.stockCode?._id;
        if (!metalId) continue;

        const [inventory, metal] = await Promise.all([
          Inventory.findOne({ metal: new mongoose.Types.ObjectId(metalId) }),
          MetalStock.findById(metalId),
        ]);

        if (!inventory) {
          throw createAppError(
            `Inventory not found for metal: ${item.stockCode.code}`,
            404,
            "INVENTORY_NOT_FOUND"
          );
        }

        const factor = isSale ? -1 : 1;
        const pcsDelta = factor * (item.pieces || 0);
        const weightDelta = factor * (item.grossWeight || 0);

        // Optional: stock validation
        // if (inventory.pcsCount + pcsDelta < 0 || inventory.grossWeight + weightDelta < 0) {
        //   throw createAppError(`Insufficient stock for metal: ${metal.code}`, 400, "INSUFFICIENT_STOCK");
        // }

        inventory.pcsCount += pcsDelta;
        inventory.grossWeight += weightDelta;
        // inventory.pureWeight = (inventory.grossWeight * inventory.purity) / 100;
        inventory.pureWeight = (inventory.grossWeight * inventory.purity) 

        await inventory.save();
        updated.push(inventory);

        // Inventory Log
        await InventoryLog.create({
          code: metal.code,
          stockCode: metal._id,
          voucherCode: transaction.voucherNumber || item.voucherNumber || '',
          voucherDate: transaction.voucherDate || new Date(),
          grossWeight: item.grossWeight || 0,
          action: isSale ? "remove" : "add",
          transactionType: transaction.transactionType || item.transactionType || (isSale ? "sale" : "purchase"),
          createdBy: transaction.createdBy || admin || null,
          pcs: !!item.pieces,  // whether it's piece-based
          note: isSale
            ? "Inventory reduced due to sale transaction"
            : "Inventory increased due to purchase transaction"
        });
      }

      return updated;
    } catch (error) {
      if (error.name === "AppError") throw error;
      throw createAppError(
        error.message || "Failed to update inventory",
        500,
        "INVENTORY_UPDATE_FAILED"
      );
    }
  }


  static async createRegistryEntry({
    transactionId,
    metalId,
    InventoryLogID,
    type,
    goldBidValue,
    description,
    value,
    debit = 0,
    credit = 0,
    reference = null,
    party = null,
    isBullion = null,
    costCenter = "INVENTORY",
    createdBy,
    purity,
    grossWeight,
    pureWeight,
  }) {
    try {
      const registryEntry = new Registry({
        transactionId,
        metalId,
        InventoryLogID,
        costCenter,
        type,
        goldBidValue,
        description,
        goldDebit: value,
        value,
        debit: value,
        credit: 0,
        reference,
        party,
        isBullion,
        createdBy,
        status: "completed",
        purity,
        grossWeight,
        pureWeight,
      });

      return await registryEntry.save();
    } catch (error) {
      console.error("Failed to create registry entry:", error);
      // Don't throw error to prevent inventory update from failing
      // Log the error for debugging purposes
    }
  }
}

export default InventoryService;
