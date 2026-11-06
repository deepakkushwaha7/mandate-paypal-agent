// Demo data: a DTC brand ("Northwind Coffee Co.") that reorders branded
// packaging from three suppliers. Prices are per unit, in EUR.

function seed() {
  const now = Date.now();
  const day = 86400000;

  const suppliers = [
    { id: 'sup-boxly', name: 'Boxly Packaging BV', country: 'NL' },
    { id: 'sup-tissu', name: 'Tissu Print GmbH', country: 'DE' },
    { id: 'sup-label', name: 'LabelWorks Ltd', country: 'IE' },
    { id: 'sup-promo', name: 'PromoMax Wholesale', country: 'CN' },
  ];

  const catalogue = [
    { sku: 'MBX-S-KRAFT', name: 'Mailer box S, kraft, 1-colour logo', category: 'packaging', supplierId: 'sup-boxly', unitPrice: 0.62, moq: 250, packSize: 50, leadTimeDays: 7 },
    { sku: 'MBX-M-KRAFT', name: 'Mailer box M, kraft, 1-colour logo', category: 'packaging', supplierId: 'sup-boxly', unitPrice: 0.88, moq: 250, packSize: 50, leadTimeDays: 7 },
    { sku: 'TIS-A3-GOLD', name: 'Tissue paper A3, gold foil logo', category: 'packaging', supplierId: 'sup-tissu', unitPrice: 0.11, moq: 1000, packSize: 500, leadTimeDays: 10 },
    { sku: 'STK-60-ROUND', name: 'Round sticker 60 mm, matte', category: 'labels', supplierId: 'sup-label', unitPrice: 0.045, moq: 1000, packSize: 1000, leadTimeDays: 5 },
    { sku: 'LBL-BAG-250', name: 'Coffee bag label 250 g, roast date field', category: 'labels', supplierId: 'sup-label', unitPrice: 0.07, moq: 2000, packSize: 1000, leadTimeDays: 5 },
    { sku: 'TOTE-CANVAS', name: 'Canvas tote, screen printed', category: 'merch', supplierId: 'sup-promo', unitPrice: 2.4, moq: 100, packSize: 50, leadTimeDays: 21 },
  ];

  const inventory = [
    { sku: 'MBX-S-KRAFT', onHand: 310, dailyUsage: 42 },
    { sku: 'MBX-M-KRAFT', onHand: 1450, dailyUsage: 18 },
    { sku: 'TIS-A3-GOLD', onHand: 900, dailyUsage: 60 },
    { sku: 'STK-60-ROUND', onHand: 2600, dailyUsage: 55 },
    { sku: 'LBL-BAG-250', onHand: 1200, dailyUsage: 140 },
    { sku: 'TOTE-CANVAS', onHand: 40, dailyUsage: 3 },
  ];

  // Last paid unit prices, used to detect supplier price drift.
  const priceHistory = {
    'MBX-S-KRAFT': 0.58,
    'MBX-M-KRAFT': 0.88,
    'TIS-A3-GOLD': 0.11,
    'STK-60-ROUND': 0.045,
    'LBL-BAG-250': 0.07,
    'TOTE-CANVAS': 2.4,
  };

  const mandate = {
    currency: 'EUR',
    active: true,
    monthlyCap: 2500,
    perOrderCap: 1500,
    autoApproveBelow: 400,
    allowedSupplierIds: ['sup-boxly', 'sup-tissu', 'sup-label'],
    allowedCategories: ['packaging', 'labels'],
    maxPriceIncreasePct: 5,
    undoWindowSec: 60,
    vaultId: null,
    vaultLabel: null,
    vaultBlocked: false,
    version: 1,
    plainText: 'Up to €2,500 a month and €1,500 per order. Pay anything under €400 on your own. Only packaging and labels, from Boxly, Tissu Print and LabelWorks. Ask me if a supplier raises prices more than 5%.',
    // Spend already committed this month before the demo starts.
    openingSpend: 640,
  };

  return {
    company: { name: 'Northwind Coffee Co.', buyer: 'Priya (Ops lead)' },
    suppliers,
    catalogue,
    inventory,
    priceHistory,
    mandate,
    agents: [
      { id: 'reorder-agent', name: 'Reorder agent', kind: 'Built-in · Claude', active: true, monthlyCap: 2000 },
      { id: 'claude-desktop', name: 'Claude Desktop', kind: 'External · MCP', active: true, monthlyCap: 300 },
    ],
    orders: [],
    audit: [
      { at: new Date(now - 2 * day).toISOString(), actor: 'Priya', type: 'mandate.updated', message: 'Mandate created: €2,500/month, auto-pay below €400.' },
    ],
    seq: 1000,
  };
}

module.exports = { seed };
