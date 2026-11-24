const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const OWNER_UID = "owner_uid_1";
const LABOUR_UID = "labour_uid_2";
const OTHER_UID = "stranger_uid_3";
const VALID_SYNC_CODE = "THN8K4M2P";

const [emulatorHost, emulatorPortStr] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085").split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

test("Unauthenticated user cannot read or write any shop collection or invite", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection("shop_invites").get());
  await assertFails(unauthDb.collection("shop_invites").doc(VALID_SYNC_CODE).get());
  await assertFails(unauthDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").get());
  await assertFails(unauthDb.collection("thennaval_ai").doc(OWNER_UID).collection("orders").get());
  await assertFails(unauthDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").get());
  await assertFails(unauthDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").get());
  await assertFails(
    unauthDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("p1").set({
      name: "Test",
      category: "Battery",
      purchasePrice: 100,
      sellingPrice: 200,
      qty: 5,
      minStock: 2,
      lastAlertState: "OK",
      createdAt: new Date(Date.now() - 1000),
      updatedAt: new Date(Date.now() - 1000),
    })
  );
});

test("Cross-user isolation blocks non-members from reading, listing, or hijacking shop data", async () => {
  const ts = new Date(Date.now() - 5000);
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("shop_invites").doc(VALID_SYNC_CODE).set({
      ownerUid: OWNER_UID,
      inviteCode: VALID_SYNC_CODE,
      shopName: "Thennaval Mobile Spares",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    });
    await ctx.firestore().collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("p1").set({
      name: "Redmi Display",
      category: "Display & Touch Combo",
      purchasePrice: 1450,
      sellingPrice: 2150,
      qty: 10,
      minStock: 5,
      lastAlertState: "OK",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    });
  });

  const strangerDb = testEnv.authenticatedContext(OTHER_UID).firestore();
  const assert = require("node:assert/strict");
  await assertFails(strangerDb.collection("shop_invites").get());
  await assertFails(strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").get());
  await assertFails(
    strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").where("memberUids", "array-contains", OWNER_UID).get()
  );
  const strangerOwnSnap = await assertSucceeds(
    strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").where("memberUids", "array-contains", OTHER_UID).get()
  );
  assert.equal(strangerOwnSnap.size, 0);
  await assertFails(strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("p1").get());
  await assertFails(
    strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("p1").update({
      qty: 0,
      lastAlertState: "EMPTY",
      updatedAt: new Date(Date.now() - 1000),
    })
  );
  // Stranger cannot join with a bogus invite code
  await assertFails(
    strangerDb.collection("thennaval_ai").doc(OWNER_UID).collection("team_devices").doc(OTHER_UID).set({
      memberUid: OTHER_UID,
      deviceName: "Evil Phone",
      email: "evil@example.com",
      inviteCode: "WRONGCODE1",
      roleHint: "Labour",
      createdAt: ts,
      updatedAt: ts,
    })
  );
});

test("Multi-mobile sync: Owner invites, Labour joins via code, and both sync products/orders/payments while protecting Owner settings", async () => {
  const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
  const labourDb = testEnv.authenticatedContext(LABOUR_UID).firestore();
  const ts = new Date(Date.now() - 5000);

  // 1. Owner publishes invite & shop profile + staff + product
  await assertSucceeds(
    ownerDb.collection("shop_invites").doc(VALID_SYNC_CODE).set({
      ownerUid: OWNER_UID,
      inviteCode: VALID_SYNC_CODE,
      shopName: "Thennaval Mobile Spares",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("shop_profile").doc("main").set({
      shopName: "Thennaval Mobile Spares",
      ownerName: "Thennaval Selvam",
      mobile: "8526820655",
      email: "mechmoorthi007@gmail.com",
      address: "Main Bazaar Road",
      lowStockThreshold: 5,
      whatsappAutoPrompt: false,
      whatsappAutoLaunchOnDrop: true,
      whatsappWebhookEnabled: false,
      whatsappGroupName: "Thennaval Stock Alerts",
      whatsappGroupId: "8526820655",
      emailAlertEnabled: true,
      weeklyReportEnabled: true,
      lastWeeklyReportDate: "",
      syncCode: VALID_SYNC_CODE,
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_owner").set({
      role: "Owner",
      name: "Shop Owner",
      username: "admin",
      passwordHash: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
      mobile: "8526820655",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_labour").set({
      role: "Labour",
      name: "Karthik Staff",
      username: "labour",
      passwordHash: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
      mobile: "9842100002",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_1").set({
      name: "Samsung A54 Battery",
      category: "Battery",
      modelTag: "Samsung A54",
      purchasePrice: 520,
      sellingPrice: 890,
      qty: 10,
      minStock: 5,
      lastAlertState: "OK",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // 2. Labour phone looks up invite & joins team_devices
  await assertSucceeds(labourDb.collection("shop_invites").doc(VALID_SYNC_CODE).get());
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("team_devices").doc(LABOUR_UID).set({
      memberUid: LABOUR_UID,
      deviceName: "Redmi Note 12",
      email: "karthik@gmail.com",
      inviteCode: VALID_SYNC_CODE,
      roleHint: "Labour",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // 3. Owner syncs memberUids onto workspace docs (simulating ShopViewModel auto-sync)
  const syncedMembers = [OWNER_UID, LABOUR_UID];
  const syncTs = new Date(Date.now() - 3000);
  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("shop_profile").doc("main").update({
      memberUids: syncedMembers,
      updatedAt: syncTs,
    })
  );
  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_owner").update({
      memberUids: syncedMembers,
      updatedAt: syncTs,
    })
  );
  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_labour").update({
      memberUids: syncedMembers,
      updatedAt: syncTs,
    })
  );
  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_1").update({
      memberUids: syncedMembers,
      updatedAt: syncTs,
    })
  );

  // 4. Labour queries with memberUids array-contains (matches ShopRepository)
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").where("memberUids", "array-contains", LABOUR_UID).get()
  );
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").where("memberUids", "array-contains", LABOUR_UID).get()
  );

  // Unfiltered query by Labour fails cleanly
  await assertFails(labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").get());

  // 5. Labour updates stock & creates order + payment; Owner receives them
  const actTs = new Date(Date.now() - 2000);
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_1").update({
      qty: 4,
      lastAlertState: "LOW",
      updatedAt: actTs,
    })
  );
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("orders").doc("ord_labour_1").set({
      orderCode: "ORD-2001",
      date: "2026-11-23",
      shopId: "shp_1",
      shopName: "Viki Mobile",
      ownerName: "Viki",
      phone: "9843011223",
      status: "Pending",
      items: [
        {
          productId: "prd_1",
          name: "Samsung A54 Battery",
          category: "Battery",
          qty: 6,
          unitPrice: 890,
          purchasePrice: 520,
        },
      ],
      totalAmount: 5340,
      totalCost: 3120,
      notes: "Dispatched by Labour",
      memberUids: syncedMembers,
      createdAt: actTs,
      updatedAt: actTs,
    })
  );
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").doc("pay_labour_1").set({
      orderId: "ord_labour_1",
      orderCode: "ORD-2001",
      date: "2026-11-23",
      shopId: "shp_1",
      shopName: "Viki Mobile",
      ownerName: "Viki",
      productName: "Samsung A54 Battery",
      amount: 5340,
      method: "Cash",
      status: "Completed",
      note: "Collected",
      memberUids: syncedMembers,
      createdAt: actTs,
      updatedAt: actTs,
    })
  );

  // 5b. Labour adds NEW stock product & payment -> Owner sees them; Owner adds NEW stock product -> Labour sees it
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_labour_new").set({
      name: "iPhone 13 OLED Combo",
      category: "Display & Touch Combo",
      modelTag: "iPhone 13",
      purchasePrice: 3200,
      sellingPrice: 4800,
      qty: 6,
      minStock: 2,
      lastAlertState: "OK",
      memberUids: syncedMembers,
      createdAt: actTs,
      updatedAt: actTs,
    })
  );
  const assert = require("node:assert/strict");
  const ownerProductsSnap = await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").get()
  );
  assert.ok(ownerProductsSnap.docs.some((d) => d.id === "prd_labour_new"));

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_owner_new").set({
      name: "OnePlus 11R Charging Flex",
      category: "Charging Port / Flex",
      modelTag: "OnePlus 11R",
      purchasePrice: 240,
      sellingPrice: 520,
      qty: 8,
      minStock: 3,
      lastAlertState: "OK",
      memberUids: syncedMembers,
      createdAt: actTs,
      updatedAt: actTs,
    })
  );
  const labourProductsSnap = await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").where("memberUids", "array-contains", LABOUR_UID).get()
  );
  assert.ok(labourProductsSnap.docs.some((d) => d.id === "prd_owner_new"));
  const ownerPaymentsSnap = await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").get()
  );
  assert.ok(ownerPaymentsSnap.docs.some((d) => d.id === "pay_labour_1"));

  // 5c. Owner edits existing stock & payment (preserving memberUids) -> Labour still sees them;
  //     Labour edits existing stock & payment -> Owner sees the updates!
  const editTs = new Date(Date.now() - 1500);
  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_1").update({
      name: "Samsung A54 Battery (OEM)",
      category: "Battery",
      modelTag: "Samsung A54",
      purchasePrice: 540,
      sellingPrice: 920,
      qty: 14,
      minStock: 5,
      lastAlertState: "OK",
      memberUids: syncedMembers,
      updatedAt: editTs,
    })
  );
  const labourEditedProdSnap = await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").where("memberUids", "array-contains", LABOUR_UID).get()
  );
  const editedPrd1 = labourEditedProdSnap.docs.find((d) => d.id === "prd_1")?.data();
  assert.equal(editedPrd1.qty, 14);
  assert.equal(editedPrd1.sellingPrice, 920);

  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_owner_new").update({
      name: "OnePlus 11R Charging Flex",
      category: "Charging Port / Flex",
      modelTag: "OnePlus 11R",
      purchasePrice: 240,
      sellingPrice: 520,
      qty: 3,
      minStock: 3,
      lastAlertState: "LOW",
      updatedAt: editTs,
    })
  );
  const ownerEditedProdSnap = await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_owner_new").get()
  );
  assert.equal(ownerEditedProdSnap.data().qty, 3);
  assert.equal(ownerEditedProdSnap.data().lastAlertState, "LOW");

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").doc("pay_labour_1").update({
      date: "2026-11-23",
      shopId: "shp_1",
      shopName: "Viki Mobile",
      ownerName: "Viki",
      productName: "Samsung A54 Battery",
      amount: 5500,
      method: "UPI",
      status: "Completed",
      note: "Updated by Owner",
      memberUids: syncedMembers,
      updatedAt: editTs,
    })
  );
  const labourEditedPaySnap = await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").where("memberUids", "array-contains", LABOUR_UID).get()
  );
  assert.equal(labourEditedPaySnap.docs.find((d) => d.id === "pay_labour_1")?.data().amount, 5500);

  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").doc("pay_labour_1").update({
      status: "Pending",
      updatedAt: new Date(Date.now() - 1200),
    })
  );
  const ownerEditedPaySnap = await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("payments").doc("pay_labour_1").get()
  );
  assert.equal(ownerEditedPaySnap.data().status, "Pending");

  // 6. Security checks on Labour role:
  // Labour can change Labour username/password, but CANNOT modify Owner account or Shop Profile!
  await assertSucceeds(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_labour").update({
      username: "karthik_staff",
      passwordHash: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      updatedAt: new Date(Date.now() - 1000),
    })
  );
  await assertFails(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_owner").update({
      username: "hijack_admin",
      passwordHash: "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92",
      updatedAt: new Date(Date.now() - 1000),
    })
  );
  await assertFails(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("shop_profile").doc("main").update({
      email: "attacker@example.com",
      updatedAt: new Date(Date.now() - 1000),
    })
  );
  // Labour cannot strip OWNER_UID from memberUids
  await assertFails(
    labourDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_1").update({
      memberUids: [LABOUR_UID],
      updatedAt: new Date(Date.now() - 1000),
    })
  );
});

test("Owner validation rules enforce strict schema bounds and reject ghost fields / future timestamps", async () => {
  const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
  const ts = new Date(Date.now() - 5000);

  await assertFails(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("staff_accounts").doc("acc_ghost").set({
      role: "Owner",
      name: "Ghost",
      username: "ghost",
      passwordHash: "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4",
      isSuperAdmin: true,
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertFails(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_2").set({
      id: "prd_2",
      name: "Bad Product",
      category: "Battery",
      purchasePrice: 100,
      sellingPrice: 200,
      qty: 5,
      minStock: 2,
      lastAlertState: "OK",
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertFails(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("shops").doc("shp_future").set({
      shopName: "Future Shop",
      ownerName: "Time Traveler",
      createdAt: new Date(Date.now() + 120000),
      updatedAt: new Date(Date.now() + 120000),
    })
  );
});

test("Owner stores PartnerShop details and 9AM/9PM Stock Mail alert logs in Firestore", async () => {
  const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
  const ts = new Date(Date.now() - 4000);

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("shops").doc("shp_test").set({
      shopName: "Arun Mobile Service",
      ownerName: "Arunachalam M",
      phone: "9843011223",
      address: "Main Bazaar",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("alert_logs").doc("log_9am").set({
      productId: "daily_stock_2026-11-24_09",
      productName: "Morning 9:00 AM Stock Report (1 Empty, 2 Low)",
      alertLevel: "EMPTY",
      qty: 3,
      minStock: 0,
      channel: "9AM/9PM Stock Mail",
      deliveryStatus: "Sent",
      message: "Morning 9:00 AM summary sent",
      memberUids: [OWNER_UID],
      createdAt: ts,
      updatedAt: ts,
    })
  );
});

test("Owner can get non-existent shop_invites before creating it and update memberUids on legacy docs", async () => {
  const ownerDb = testEnv.authenticatedContext(OWNER_UID).firestore();
  const ts = new Date(Date.now() - 4000);

  // Simulates upsertInviteDoc: get() on non-existent invite code followed by set()
  const preSnap = await assertSucceeds(ownerDb.collection("shop_invites").doc("THN998877").get());
  const assert = require("node:assert/strict");
  assert.equal(preSnap.exists, false);

  await assertSucceeds(
    ownerDb.collection("shop_invites").doc("THN998877").set({
      ownerUid: OWNER_UID,
      inviteCode: "THN998877",
      shopName: "Thennaval Mobile Spares",
      active: true,
      createdAt: ts,
      updatedAt: ts,
    })
  );

  // Legacy product without createdAt can still receive memberUids backfill
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_legacy").set({
      name: "Legacy Battery",
      category: "Battery",
      purchasePrice: 400,
      sellingPrice: 700,
      qty: 5,
      minStock: 2,
      lastAlertState: "OK",
      updatedAt: ts,
    });
  });

  await assertSucceeds(
    ownerDb.collection("thennaval_ai").doc(OWNER_UID).collection("products").doc("prd_legacy").update({
      memberUids: [OWNER_UID],
      updatedAt: new Date(Date.now() - 1000),
    })
  );
});

