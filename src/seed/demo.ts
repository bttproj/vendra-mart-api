import { placeholderImage, PHOTO, unsplashUrl } from "../config/placeholderImages.js";
import { Address } from "../models/Address.js";
import { Banner } from "../models/Banner.js";
import { Category } from "../models/Category.js";
import { City } from "../models/City.js";
import { Product } from "../models/Product.js";
import { User, type Role } from "../models/User.js";
import { Vendor } from "../models/Vendor.js";
import { hashPassword } from "../modules/auth/auth.service.js";
import { seedReferenceData, slugify } from "./reference.js";

// Demo data for showing the client the whole product: two approved stores with photographed products, a
// delivery handler, and a customer with a saved address. Safe to run repeatedly: anything that already exists
// (matched by email or slug) is left exactly as it is. Photos are Unsplash stand-ins (see config/placeholderImages).

export const DEMO_EMAIL_DOMAIN = "vendramart.test";

const USERS: { role: Role; name: string; email: string; phone: string }[] = [
  { role: "VENDOR", name: "Bola Adeyinka", email: `vendor@${DEMO_EMAIL_DOMAIN}`, phone: "08031234567" },
  { role: "VENDOR", name: "Ife Balogun", email: `adire@${DEMO_EMAIL_DOMAIN}`, phone: "08037654321" },
  { role: "HANDLER", name: "Femi Rider", email: `handler@${DEMO_EMAIL_DOMAIN}`, phone: "08051112222" },
  { role: "CUSTOMER", name: "Tolu Adeyemi", email: `customer@${DEMO_EMAIL_DOMAIN}`, phone: "08034127781" },
];

const STORES = [
  {
    email: `vendor@${DEMO_EMAIL_DOMAIN}`,
    businessName: "Bodija Provisions",
    owner: "Bola Adeyinka",
    phone: "08031234567",
    description: "Grains, flour, oils and kitchen staples from Bodija Market.",
    logoPhoto: PHOTO.jarsShelf,
    pickup: { line: "Bodija Market, Ibadan", lat: 7.4318, lng: 3.9144 },
    bank: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Bodija Provisions" },
  },
  {
    email: `adire@${DEMO_EMAIL_DOMAIN}`,
    businessName: "Adire House",
    owner: "Ife Balogun",
    phone: "08037654321",
    description: "Ready-to-wear adire, tie-dye pieces and handmade beads from Ibadan makers.",
    logoPhoto: PHOTO.printFabricC,
    pickup: { line: "Dugbe, Ibadan", lat: 7.3869, lng: 3.8922 },
    bank: { bankName: "Access Bank", accountNumber: "0456789012", accountName: "Adire House" },
  },
] as const;

// [store index, category slug, name, price in kobo, stock, units sold, photos, description]
type DemoProduct = [number, string, string, number, number, number, string[], string];
const PRODUCTS: DemoProduct[] = [
  [0, "grains-and-flour", "Omosalewa Bean Flour", 1500000, 30, 40, [PHOTO.flourSack, PHOTO.flourShelf, PHOTO.flourBag], "Smooth, ready-to-cook bean flour for moin moin and akara. Sealed 2 kg pack."],
  [0, "grains-and-flour", "Garri Ijebu, white bag", 1500000, 12, 55, [PHOTO.cassavaB, PHOTO.cassavaA], "Crisp, sour Ijebu garri, sun-dried and sieved fine. 5 kg bag."],
  [0, "oils-and-condiments", "Banga Palm Oil, 4L", 1530000, 8, 31, [PHOTO.oilBottles, PHOTO.oilDispenser], "Rich red palm oil for soups and stews. Unadulterated and freshly filled."],
  [0, "oils-and-condiments", "King's Vegetable Oil, 5L", 1850000, 15, 47, [PHOTO.oilDispenser, PHOTO.oilOlive], "Light, clear vegetable oil for frying and cooking. 5 litre can."],
  [0, "beans-and-legumes", "Oloyin (Honey) Beans", 1150000, 25, 22, [PHOTO.beansBeige, PHOTO.beansSpoons], "Sweet honey beans, stone-free and hand picked. Cooks quickly. 5 kg."],
  [0, "tubers-and-produce", "Yam tuber", 507000, 40, 18, [PHOTO.yams, PHOTO.sweetPotatoes], "Fresh Ibadan yam tuber, firm and ready to boil or pound."],
  [1, "fashion", "Tie-Dye T-Shirt, free size", 1200000, 14, 9, [PHOTO.tieDyeShirt, PHOTO.tieDyeNecklaces], "Hand-dyed cotton tee with a relaxed free-size fit. Each piece is slightly different."],
  [1, "fashion", "Ready-to-wear Adire Pants", 1500000, 10, 6, [PHOTO.printFabricA, PHOTO.kenteDress, PHOTO.printFabricB], "Wide-leg pants cut from hand-printed adire cloth. Elastic waist."],
  [1, "accessories", "Kente Beads, set of 6", 1200000, 20, 4, [PHOTO.beadsHand, PHOTO.beadsBracelet], "Six handmade beaded bracelets in bright traditional colours."],
  [1, "beauty-and-fragrance", "Bex Nomad Perfume, 50ml", 1100000, 0, 2, [PHOTO.perfumeBottle], "Warm, woody everyday fragrance. 50 ml spray. Currently sold out."],
  [0, "tubers-and-produce", "Sweet potato, 1 kg", 250000, 60, 15, [PHOTO.sweetPotatoes, PHOTO.yams], "Orange-fleshed sweet potato, freshly dug and ready to roast or boil."],
  [0, "tubers-and-produce", "Cassava tubers, 3 kg", 300000, 35, 11, [PHOTO.cassavaA, PHOTO.cassavaB], "Firm cassava tubers for fufu, garri or boiling."],
  [0, "tubers-and-produce", "Fresh tomatoes, basket", 1200000, 20, 28, [PHOTO.marketTomatoes, PHOTO.marketFruit], "A full basket of ripe market tomatoes for stews and sauces."],
  [0, "tubers-and-produce", "Mixed market fruit, tray", 1800000, 10, 7, [PHOTO.marketFruit, PHOTO.marketTomatoes], "A tray of seasonal fruit picked fresh from the market."],
  [0, "beans-and-legumes", "Brown beans, 5 kg", 1300000, 22, 19, [PHOTO.beansMixed, PHOTO.beansBeige], "Clean, stone-free brown beans with a rich flavour. 5 kg."],
  [0, "beans-and-legumes", "Black-eyed beans, 2 kg", 650000, 30, 14, [PHOTO.beansSpoons, PHOTO.beansMixed], "Creamy black-eyed beans for moin moin, akara and gbegiri."],
  [0, "grains-and-flour", "Plantain flour (elubo), 2 kg", 900000, 18, 12, [PHOTO.flourBag, PHOTO.flourShelf], "Fine plantain flour for smooth, soft amala."],
  [0, "oils-and-condiments", "Extra virgin olive oil, 1L", 2400000, 9, 8, [PHOTO.oilOlive, PHOTO.oilBottles], "Cold-pressed olive oil for salads, dips and light cooking."],
  [0, "oils-and-condiments", "Groundnut oil, 3L", 1650000, 14, 10, [PHOTO.oilBottles, PHOTO.oilDispenser], "Pure groundnut oil with a clean taste. 3 litre bottle."],
  [1, "fashion", "Adire Fabric, 6 yards", 3900000, 12, 8, [PHOTO.printFabricA, PHOTO.printFabricC], "Hand-dyed indigo adire cloth, ready to sew. 6 yards."],
  [1, "fashion", "Ankara Print Fabric, 6 yards", 3500000, 16, 10, [PHOTO.printFabricB, PHOTO.printFabricC], "Bold, colourfast Ankara print. 6 yards."],
  [1, "fashion", "Kente Wrap Dress", 2800000, 7, 5, [PHOTO.kenteDress, PHOTO.printFabricA], "A flattering wrap dress in woven kente colours. One size."],
  [1, "fashion", "Hand-dyed Scarf", 800000, 25, 6, [PHOTO.printFabricC, PHOTO.printFabricB], "Soft cotton scarf, dyed by hand in small batches."],
  [1, "fashion", "Adire Tote Bag", 1400000, 15, 4, [PHOTO.printFabricB, PHOTO.printFabricA], "Roomy tote sewn from printed adire cloth."],
  [1, "accessories", "Tie-dye Beaded Necklace", 1000000, 18, 5, [PHOTO.tieDyeNecklaces, PHOTO.beadsHand], "Layered handmade beads in tie-dye colours."],
  [1, "accessories", "Waist Beads, set of 3", 700000, 30, 9, [PHOTO.beadsBracelet, PHOTO.beadsHand], "Three strands of handmade glass waist beads."],
];

export const DEMO_PRODUCT_COUNT = PRODUCTS.length;

export interface DemoResult {
  users: number;
  vendors: number;
  products: number;
}

const BANNERS: { placement: "HERO" | "SIDE" | "STRIP"; title: string; subtitle?: string; ctaLabel: string; link: string; photo: string; width: number }[] = [
  { placement: "HERO", title: "Fresh from Ibadan's markets, at your door", subtitle: "Yam, beans, flour and oil from local vendors, in one cart", ctaLabel: "Shop now", link: "/search/", photo: PHOTO.marketWoman, width: 1600 },
  { placement: "HERO", title: "Kitchen staples, delivered", subtitle: "Stock up on grains, flour and cooking oil", ctaLabel: "Shop staples", link: "/category/?slug=grains-and-flour", photo: PHOTO.grainMarket, width: 1600 },
  { placement: "HERO", title: "Made in Nigeria", subtitle: "Adire, tie-dye and handmade beads from Ibadan makers", ctaLabel: "Explore fashion", link: "/category/?slug=fashion", photo: PHOTO.kenteDress, width: 1600 },
  { placement: "HERO", title: "Sell on VendraMart", subtitle: "We handle checkout and delivery. You get paid 4 working days after delivery", ctaLabel: "Become a vendor", link: "/vendor/register/", photo: PHOTO.marketFruit, width: 1600 },
  { placement: "SIDE", title: "Tubers and produce", subtitle: "Yam, cassava, sweet potato", ctaLabel: "Shop", link: "/category/?slug=tubers-and-produce", photo: PHOTO.yams, width: 900 },
  { placement: "SIDE", title: "Fashion", subtitle: "Prints and ready-to-wear", ctaLabel: "Shop", link: "/category/?slug=fashion", photo: PHOTO.tieDyeShirt, width: 900 },
  { placement: "STRIP", title: "Kitchen staples", ctaLabel: "Shop now", link: "/category/?slug=grains-and-flour", photo: PHOTO.grainMarket, width: 1000 },
  { placement: "STRIP", title: "Fresh produce", ctaLabel: "Shop now", link: "/category/?slug=tubers-and-produce", photo: PHOTO.marketTomatoes, width: 1000 },
  { placement: "STRIP", title: "Beads and accessories", ctaLabel: "Shop now", link: "/category/?slug=accessories", photo: PHOTO.beadsHand, width: 1000 },
];

/** Campaign banners for the home page. Only added when there are none, so what an admin has set up is never touched. */
async function seedDemoBanners() {
  if (await Banner.exists({})) return;
  const order = new Map<string, number>();
  for (const b of BANNERS) {
    const sortOrder = order.get(b.placement) ?? 0;
    order.set(b.placement, sortOrder + 1);
    await Banner.create({ placement: b.placement, title: b.title, subtitle: b.subtitle, ctaLabel: b.ctaLabel, link: b.link, image: unsplashUrl(b.photo, b.width), sortOrder });
  }
}

export async function seedDemoData(password: string): Promise<DemoResult> {
  await seedReferenceData();
  const ibadan = (await City.findOne({ slug: "ibadan" }))!;
  const passwordHash = await hashPassword(password);
  const result: DemoResult = { users: 0, vendors: 0, products: 0 };

  const userByEmail = new Map<string, InstanceType<typeof User>>();
  for (const u of USERS) {
    let doc = await User.findOne({ email: u.email });
    if (!doc) {
      doc = await User.create({ ...u, passwordHash });
      result.users++;
    }
    userByEmail.set(u.email, doc);
  }

  const vendorDocs: InstanceType<typeof Vendor>[] = [];
  for (const s of STORES) {
    const slug = slugify(s.businessName);
    let vendor = await Vendor.findOne({ slug });
    if (!vendor) {
      vendor = await Vendor.create({
        userId: userByEmail.get(s.email)!._id,
        businessName: s.businessName,
        slug,
        ownerName: s.owner,
        phone: s.phone,
        email: `${slug}@${DEMO_EMAIL_DOMAIN}`,
        description: s.description,
        logo: unsplashUrl(s.logoPhoto, 300),
        bank: s.bank,
        pickup: { ...s.pickup, cityId: ibadan._id },
        status: "APPROVED",
        approvedAt: new Date(),
      });
      result.vendors++;
    }
    vendorDocs.push(vendor);
  }

  for (const [storeIndex, categorySlug, name, priceKobo, stock, soldCount, photos, description] of PRODUCTS) {
    const slug = slugify(name);
    if (await Product.exists({ slug })) continue;
    const category = await Category.findOne({ slug: categorySlug });
    await Product.create({
      vendorId: vendorDocs[storeIndex]!._id,
      cityId: ibadan._id,
      categoryId: category!._id,
      name,
      slug,
      description,
      priceKobo,
      stock,
      soldCount,
      uploadedCount: stock + soldCount,
      images: photos.map(placeholderImage),
    });
    result.products++;
  }

  await seedDemoBanners();

  const customer = userByEmail.get(`customer@${DEMO_EMAIL_DOMAIN}`)!;
  if (!(await Address.exists({ userId: customer._id }))) {
    await Address.create({
      userId: customer._id,
      label: "Home",
      line: "12 Awolowo Avenue, Old Bodija, Ibadan",
      landmark: "opposite Bodija Market gate",
      location: { lat: 7.4402, lng: 3.9206 },
      cityId: ibadan._id,
      isDefault: true,
    });
  }
  return result;
}
