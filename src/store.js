const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const uploadDir = process.env.VERCEL ? path.join(os.tmpdir(), 'fitness-uploads') : path.join(rootDir, 'uploads');
const dbFile = path.join(dataDir, 'db.json');
const databaseUrl = process.env.DATABASE_URL || '';
const stateKey = process.env.APP_STATE_KEY || 'sportshopfitness';

let cachedDb = null;
let pool = null;
let pendingPersist = Promise.resolve();
let readyPromise = null;

const nowIso = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const passwordHash = () => bcrypt.hashSync('password123', 10);
const cloneDb = (db) => JSON.parse(JSON.stringify(db));

function defaultOperationalData(trainerId, clientId, createdAt) {
  return {
    exercises: [
      {
        id: 'exercise_squat',
        owner_id: null,
        name: 'Приседание с собственным весом',
        muscle_group: 'Ноги',
        image_url: 'https://images.unsplash.com/photo-1434682881908-b43d0467b798?auto=format&fit=crop&w=900&q=80',
        video_url: '',
        description: 'Базовое упражнение для ног и корпуса.',
        technique: 'Спина нейтральная, колени направлены по линии стоп, движение начинается с таза.',
        is_public: true
      },
      {
        id: 'exercise_pushup',
        owner_id: null,
        name: 'Отжимания',
        muscle_group: 'Грудь и руки',
        image_url: 'https://images.unsplash.com/photo-1598971639058-fab3c3109a00?auto=format&fit=crop&w=900&q=80',
        video_url: '',
        description: 'Жимовое упражнение для верхней части тела.',
        technique: 'Корпус держится одной линией, локти движутся под комфортным углом.',
        is_public: true
      },
      {
        id: 'exercise_plank',
        owner_id: null,
        name: 'Планка',
        muscle_group: 'Кор',
        image_url: 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?auto=format&fit=crop&w=900&q=80',
        video_url: '',
        description: 'Статическая работа для стабилизаторов корпуса.',
        technique: 'Не проваливайте поясницу, держите плечи над локтями и ровное дыхание.',
        is_public: true
      }
    ],
    programs: [
      {
        id: 'program_start_strength',
        trainer_id: trainerId,
        name: 'Силовой старт на 4 недели',
        description: 'Демо-программа для мягкого входа в регулярные тренировки.',
        duration_days: 28,
        workouts: [
          {
            id: 'workout_start_1',
            day_label: 'День 1',
            name: 'Фулбоди база',
            description: 'Разминка, техника базовых движений и спокойная силовая работа.',
            exercises: [
              { exercise_id: 'exercise_squat', sets: 3, reps: '10', rest_seconds: 60, video_url: '' },
              { exercise_id: 'exercise_pushup', sets: 3, reps: '8-10', rest_seconds: 75, video_url: '' },
              { exercise_id: 'exercise_plank', sets: 3, reps: '30 сек', rest_seconds: 45, video_url: '' }
            ]
          }
        ]
      }
    ],
    program_assignments: [
      {
        id: 'assignment_demo',
        trainer_id: trainerId,
        client_id: clientId,
        program_id: 'program_start_strength',
        assigned_at: createdAt.slice(0, 10),
        expires_at: '2026-06-30',
        status: 'active'
      }
    ],
    progress_reports: [
      {
        id: 'progress_1',
        trainer_id: trainerId,
        client_id: clientId,
        report_date: '2026-05-12',
        weight: 82.4,
        measurements: { waist: 92, hips: 102, chest: 101, arms: 35, legs: 58 },
        photo_before: '',
        photo_after: '',
        notes: 'Стартовые замеры перед программой.',
        created_at: createdAt
      },
      {
        id: 'progress_2',
        trainer_id: trainerId,
        client_id: clientId,
        report_date: '2026-05-26',
        weight: 81,
        measurements: { waist: 90, hips: 101, chest: 101, arms: 35, legs: 58 },
        photo_before: '',
        photo_after: '',
        notes: 'Хорошая динамика, нагрузку можно слегка поднять.',
        created_at: createdAt
      }
    ],
    payments: [
      {
        id: 'payment_demo',
        trainer_id: trainerId,
        client_id: clientId,
        amount: 15900,
        payment_date: createdAt.slice(0, 10),
        payment_method: 'Карта',
        comment: 'Оплата курса силового старта',
        created_at: createdAt
      }
    ],
    calendar_events: [
      {
        id: 'event_demo',
        trainer_id: trainerId,
        client_id: clientId,
        title: 'Контрольная тренировка',
        event_type: 'Тренировка с клиентом',
        start_time: '2026-06-02T10:00',
        end_time: '2026-06-02T11:00',
        status: 'planned',
        created_at: createdAt
      }
    ],
    messages: [
      {
        id: 'message_1',
        trainer_id: trainerId,
        sender_id: trainerId,
        recipient_id: clientId,
        message_text: 'Алексей, привет! Сегодня держим спокойный темп и следим за техникой приседа.',
        file_attachment: '',
        created_at: createdAt
      },
      {
        id: 'message_2',
        trainer_id: trainerId,
        sender_id: clientId,
        recipient_id: trainerId,
        message_text: 'Принял, после тренировки пришлю ощущения и замеры.',
        file_attachment: '',
        created_at: createdAt
      }
    ]
  };
}

function createSeedDb() {
  const trainerId = 'user_trainer_demo';
  const clientId = 'user_client_demo';
  const adminId = 'user_admin_demo';
  const createdAt = nowIso();

  return {
    meta: {
      project: 'sportshopfitness.ru',
      source: 'ТЗ от 25 мая 2026',
      marketplace_commission_percent: 18,
      yandex_market_mode: 'FBS / DBS'
    },
    users: [
      { id: trainerId, email: 'trainer@sportshopfitness.local', password_hash: passwordHash(), role: 'trainer', is_blocked: false, created_at: createdAt },
      { id: clientId, email: 'client@sportshopfitness.local', password_hash: passwordHash(), role: 'client', is_blocked: false, created_at: createdAt },
      { id: adminId, email: 'admin@sportshopfitness.local', password_hash: passwordHash(), role: 'admin', is_blocked: false, created_at: createdAt }
    ],
    profiles: [
      {
        user_id: trainerId,
        full_name: 'Мария Волкова',
        phone: '+7 777 100 20 30',
        city: 'Алматы',
        specialization: 'Силовой тренинг и коррекция питания',
        avatar_url: 'https://images.unsplash.com/photo-1594381898411-846e7d193883?auto=format&fit=crop&w=500&q=80',
        rating: 4.9,
        referral_code: 'MARIAFIT',
        balance: 38600
      },
      {
        user_id: clientId,
        full_name: 'Алексей Иванов',
        phone: '+7 777 555 12 34',
        city: 'Астана',
        specialization: '',
        avatar_url: '',
        rating: 0,
        referral_code: '',
        balance: 0
      },
      {
        user_id: adminId,
        full_name: 'Администратор SportShopFitness',
        phone: '',
        city: '',
        specialization: '',
        avatar_url: '',
        rating: 0,
        referral_code: '',
        balance: 0
      }
    ],
    products: [
      {
        id: 'product_bundle_start',
        owner_id: adminId,
        title: 'Пакет Старт тренера',
        type: 'bundle',
        category: 'Пакеты',
        price: 24900,
        old_price: 31900,
        stock: 999,
        status: 'active',
        marketplace: 'platform',
        image_url: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Готовый набор: курс продаж, шаблоны программ, чек-листы питания и материалы для клиентов.',
        description: 'Бандл для фитнес-тренера, который хочет быстро запустить продажи программ и услуг: образовательные уроки, PDF-материалы, шаблоны тренировок, скрипты консультаций и базовые маркетинговые связки.',
        tags: ['курс', 'шаблоны', 'для тренера'],
        yandex_sync: 'ready'
      },
      {
        id: 'product_nutrition_pro',
        owner_id: adminId,
        title: 'Пакет питания PRO',
        type: 'digital',
        category: 'Питание',
        price: 9900,
        old_price: 12900,
        stock: 999,
        status: 'active',
        marketplace: 'platform',
        image_url: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Рационы, таблицы замены продуктов, калькулятор калорийности и инструкции для клиентов.',
        description: 'Цифровой продукт для тренеров и клиентов: недельные меню, расчет БЖУ, список покупок, корректировки под цели и готовые рекомендации.',
        tags: ['питание', 'БЖУ', 'калькулятор'],
        yandex_sync: 'ready'
      },
      {
        id: 'product_trainer_course',
        owner_id: trainerId,
        title: 'Авторский курс: силовой старт за 8 недель',
        type: 'course',
        category: 'Курсы',
        price: 15900,
        old_price: 0,
        stock: 999,
        status: 'active',
        marketplace: 'trainer',
        image_url: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Курс от тренера маркетплейса с видео, дневником прогресса и проверкой техники.',
        description: 'Программа тренировок для новичков и возвращающихся после перерыва. Включает 24 тренировки, технику упражнений, календарь нагрузок и чат-поддержку.',
        tags: ['силовой тренинг', 'программа', 'видео'],
        yandex_sync: 'queued'
      },
      {
        id: 'product_cert_card',
        owner_id: adminId,
        title: 'Подарочный сертификат SportShopFitness',
        type: 'certificate',
        category: 'Сертификаты',
        price: 20000,
        old_price: 0,
        stock: 250,
        status: 'active',
        marketplace: 'platform',
        image_url: 'https://images.unsplash.com/photo-1576678927484-cc907957088c?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Сертификат на покупку курсов, программ, консультаций и товаров для спорта.',
        description: 'Электронный сертификат, который можно применить к товарам маркетплейса, программам тренеров и сопутствующим услугам.',
        tags: ['подарок', 'сертификат'],
        yandex_sync: 'ready'
      },
      {
        id: 'product_gear_kit',
        owner_id: adminId,
        title: 'Набор для домашних тренировок',
        type: 'physical',
        category: 'Товары',
        price: 34900,
        old_price: 38900,
        stock: 34,
        status: 'active',
        marketplace: 'platform',
        image_url: 'https://images.unsplash.com/photo-1576678927484-cc907957088c?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Эспандеры, коврик, ролл, петли и инструкция с готовыми тренировками.',
        description: 'Сопутствующий товар для клиентов тренеров: комплект инвентаря с доставкой и цифровой программой на 4 недели.',
        tags: ['инвентарь', 'дом', 'доставка'],
        yandex_sync: 'synced'
      },
      {
        id: 'product_consulting',
        owner_id: trainerId,
        title: 'Разбор техники и план на месяц',
        type: 'service',
        category: 'Услуги',
        price: 12000,
        old_price: 0,
        stock: 12,
        status: 'active',
        marketplace: 'trainer',
        image_url: 'https://images.unsplash.com/photo-1599058917212-d750089bc07e?auto=format&fit=crop&w=1200&q=85',
        short_description: 'Онлайн-консультация тренера, видеоразбор и индивидуальный план тренировок.',
        description: 'Покупатель отправляет видео упражнений, получает разбор ошибок, план тренировок, рекомендации по нагрузке и контрольную встречу.',
        tags: ['услуга', 'разбор', 'онлайн'],
        yandex_sync: 'manual'
      }
    ],
    orders: [
      {
        id: 'order_1001',
        customer_id: clientId,
        product_id: 'product_bundle_start',
        seller_id: adminId,
        amount: 24900,
        status: 'paid',
        source: 'site',
        created_at: createdAt
      },
      {
        id: 'order_1002',
        customer_id: clientId,
        product_id: 'product_trainer_course',
        seller_id: trainerId,
        amount: 15900,
        status: 'paid',
        source: 'referral:MARIAFIT',
        created_at: createdAt
      }
    ],
    subscriptions: [
      { id: 'sub_base', name: 'Base', price_month: 0, price_year: 0, access: 'Каталог, покупки, базовые материалы' },
      { id: 'sub_pro', name: 'Pro Trainer', price_month: 9900, price_year: 99000, access: 'Витрина тренера, рефералка, CRM клиентов, аналитика' },
      { id: 'sub_business', name: 'Business', price_month: 29900, price_year: 299000, access: 'Командная работа, расширенная аналитика, приоритетная модерация' }
    ],
    referrals: [
      { id: 'ref_1', trainer_id: trainerId, customer_id: clientId, order_id: 'order_1002', reward: 3180, status: 'approved', created_at: createdAt }
    ],
    payout_requests: [
      { id: 'payout_1', trainer_id: trainerId, amount: 15000, status: 'pending', method: 'Карта', created_at: createdAt }
    ],
    market_sync: [
      { id: 'sync_1', channel: 'Яндекс.Маркет', mode: 'FBS', status: 'ready', updated_at: createdAt, comment: 'Каталог подготовлен к выгрузке цен и остатков.' },
      { id: 'sync_2', channel: 'Яндекс.Маркет', mode: 'DBS', status: 'queued', updated_at: createdAt, comment: 'Ожидает настройки склада и статусов заказов.' }
    ],
    clients: [
      { id: 'client_card_1', trainer_id: trainerId, customer_id: clientId, goal: 'Минус 6 кг и укрепление спины', progress: 'Вес -1.4 кг за 2 недели', next_session: '2026-06-02' }
    ],
    ...defaultOperationalData(trainerId, clientId, createdAt),
    content_library: [
      { id: 'content_1', title: 'Библиотека упражнений с видео', type: 'library', items: 120 },
      { id: 'content_2', title: 'Блог и статьи FitnesAkademiya', type: 'blog', items: 48 },
      { id: 'content_3', title: 'Калькуляторы ИМТ и калорийности', type: 'calculator', items: 4 }
    ],
    news: [
      { id: 'news_1', title: 'SportShopFitness MVP', text: 'Платформа собирается как маркетплейс товаров, услуг, курсов и инструментов для фитнес-тренеров.', created_at: createdAt },
      { id: 'news_2', title: 'Комиссия маркетплейса', text: 'Тренеры могут размещать свои программы и получать выплаты после модерации заказов.', created_at: createdAt }
    ]
  };
}

function normalizeDb(db) {
  const trainer = db.users.find((user) => user.role === 'trainer');
  const client = db.users.find((user) => user.role === 'client');
  if (!trainer || !client) return false;

  const defaults = defaultOperationalData(trainer.id, client.id, nowIso());
  let changed = false;

  Object.entries(defaults).forEach(([key, value]) => {
    if (!Array.isArray(db[key])) {
      db[key] = value;
      changed = true;
    }
  });

  db.clients.forEach((clientCard) => {
    if (!clientCard.status) {
      clientCard.status = 'active';
      changed = true;
    }
    if (clientCard.notes === undefined) {
      clientCard.notes = '';
      changed = true;
    }
    if (clientCard.birth_date === undefined) {
      clientCard.birth_date = '';
      changed = true;
    }
  });

  return changed;
}

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify(createSeedDb(), null, 2), 'utf8');
  }
}

function loadFileDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  return db.meta?.project === 'sportshopfitness.ru' ? db : createSeedDb();
}

function postgresSsl() {
  if (!databaseUrl) return undefined;
  return databaseUrl.includes('supabase.com') || databaseUrl.includes('pooler.supabase.com')
    ? { rejectUnauthorized: false }
    : undefined;
}

async function persistPostgres() {
  if (!pool || !cachedDb) return;
  const snapshot = cloneDb(cachedDb);
  pendingPersist = pendingPersist
    .catch(() => {})
    .then(() => pool.query(
      `insert into app_state (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [stateKey, snapshot]
    ))
    .catch((error) => {
      console.error(`PostgreSQL save failed: ${error.message}`);
    });
  await pendingPersist;
}

async function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = initialize();
  return readyPromise;
}

async function initialize() {
  ensureDb();
  if (!databaseUrl) {
    cachedDb = loadFileDb();
    if (normalizeDb(cachedDb)) write(cachedDb);
    return;
  }

  pool = new Pool({
    connectionString: databaseUrl,
    ssl: postgresSsl(),
    max: 5
  });

  await pool.query(`
    create table if not exists app_state (
      id text primary key,
      data jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  const existing = await pool.query('select data from app_state where id = $1', [stateKey]);
  if (existing.rowCount) {
    cachedDb = existing.rows[0].data;
  } else {
    cachedDb = loadFileDb();
    normalizeDb(cachedDb);
    await pool.query(
      'insert into app_state (id, data, updated_at) values ($1, $2::jsonb, now())',
      [stateKey, cachedDb]
    );
  }

  if (normalizeDb(cachedDb)) {
    await persistPostgres();
  }
}

function read() {
  if (!cachedDb) {
    cachedDb = loadFileDb();
    if (normalizeDb(cachedDb)) write(cachedDb);
  }
  return cloneDb(cachedDb);
}

function write(db) {
  normalizeDb(db);
  cachedDb = cloneDb(db);
  if (pool) {
    persistPostgres();
  } else {
    fs.writeFileSync(dbFile, JSON.stringify(cachedDb, null, 2), 'utf8');
  }
}

function update(mutator) {
  const db = read();
  const result = mutator(db);
  write(db);
  return result;
}

function profileFor(db, userId) {
  return db.profiles.find((profile) => profile.user_id === userId) || null;
}

function userWithProfile(db, user) {
  if (!user) return null;
  return { ...user, profile: profileFor(db, user.id) };
}

function productWithSeller(db, product) {
  const seller = db.users.find((user) => user.id === product.owner_id);
  return { ...product, seller, sellerProfile: profileFor(db, product.owner_id) };
}

module.exports = {
  rootDir,
  uploadDir,
  ready,
  read,
  write,
  update,
  id,
  nowIso,
  userWithProfile,
  profileFor,
  productWithSeller
};
