const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const store = require('./store');
const PgSession = require('connect-pg-simple')(session);

const app = express();
const port = process.env.PORT || 3000;
const upload = multer({ dest: path.join(store.uploadDir, 'attachments') });
const databaseUrl = process.env.DATABASE_URL || '';
const sessionStore = databaseUrl ? new PgSession({
  conObject: {
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('supabase.com') || databaseUrl.includes('pooler.supabase.com')
      ? { rejectUnauthorized: false }
      : undefined
  },
  tableName: 'user_sessions',
  createTableIfMissing: true
}) : undefined;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(upload.any());
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(store.uploadDir));
app.use(async (req, res, next) => {
  try {
    await store.ready();
    next();
  } catch (error) {
    next(error);
  }
});
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'sportshopfitness-local-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = store.id('csrf');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.body?._csrf !== req.session.csrfToken) {
    return res.status(403).render('error', {
      title: 'Ошибка безопасности',
      message: 'CSRF-токен устарел. Обновите страницу и повторите действие.'
    });
  }
  next();
});

const money = (value) => new Intl.NumberFormat('ru-RU').format(Number(value || 0)) + ' ₽';
const formatDate = (value) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
const activeProducts = (db) => db.products.filter((product) => product.status === 'active').map((product) => store.productWithSeller(db, product));

app.locals.money = money;
app.locals.formatDate = formatDate;

function flash(req, type, text) {
  req.session.flash = { type, text };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect(`/login?role=${role}`);
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Доступ закрыт',
        message: 'У вашей роли нет доступа к этому разделу.'
      });
    }
    next();
  };
}

function orderWithDetails(db, order) {
  const product = db.products.find((item) => item.id === order.product_id);
  const customer = db.users.find((item) => item.id === order.customer_id);
  const seller = db.users.find((item) => item.id === order.seller_id);
  return {
    ...order,
    product,
    customer,
    customerProfile: store.profileFor(db, order.customer_id),
    seller,
    sellerProfile: store.profileFor(db, order.seller_id)
  };
}

function fileByField(req, field) {
  return (req.files || []).find((file) => file.fieldname === field);
}

function uploadUrl(file) {
  if (!file) return '';
  return `/uploads/${path.relative(store.uploadDir, file.path).split(path.sep).join('/')}`;
}

function addDays(dateValue, days) {
  const date = new Date(dateValue || Date.now());
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function trainerClients(db, trainerId) {
  return db.clients
    .filter((client) => client.trainer_id === trainerId)
    .map((client) => {
      const userId = client.customer_id || client.user_id;
      const user = db.users.find((item) => item.id === userId) || {};
      const profile = store.profileFor(db, userId) || {};
      return {
        ...client,
        user_id: userId,
        email: user.email || '',
        full_name: profile.full_name || user.email || 'Клиент',
        phone: profile.phone || '',
        city: profile.city || '',
        birth_date: client.birth_date || '',
        status: client.status || 'active',
        notes: client.notes || ''
      };
    });
}

function primaryTrainerForClient(db, clientId) {
  const card = db.clients.find((item) => (item.customer_id || item.user_id) === clientId);
  const trainerId = card?.trainer_id || db.users.find((user) => user.role === 'trainer')?.id;
  const profile = trainerId ? store.profileFor(db, trainerId) : null;
  return {
    id: trainerId,
    full_name: profile?.full_name || 'Тренер',
    profile
  };
}

function programWithDetails(db, assignment) {
  if (!assignment) return null;
  const program = db.programs.find((item) => item.id === assignment.program_id);
  if (!program) return null;
  return {
    assignment,
    program,
    workouts: program.workouts.map((workout) => ({
      ...workout,
      exercises: workout.exercises.map((item) => ({
        ...item,
        exercise: db.exercises.find((exercise) => exercise.id === item.exercise_id)
      }))
    }))
  };
}

function currentProgramForClient(db, clientId) {
  const assignment = db.program_assignments
    .filter((item) => item.client_id === clientId && item.status === 'active')
    .sort((a, b) => String(b.assigned_at).localeCompare(String(a.assigned_at)))[0];
  return programWithDetails(db, assignment);
}

function csvResponse(res, filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);
}

app.get('/', (req, res) => {
  const db = store.read();
  const products = activeProducts(db);
  res.render('landing', {
    title: 'Маркетплейс для фитнес-тренеров',
    products: products.slice(0, 6),
    bundles: products.filter((item) => item.type === 'bundle').slice(0, 3),
    subscriptions: db.subscriptions,
    library: db.content_library,
    news: db.news.slice(-3).reverse()
  });
});

app.get('/catalog', (req, res) => {
  const db = store.read();
  let products = activeProducts(db);
  const query = String(req.query.q || '').trim().toLowerCase();
  if (query) {
    products = products.filter((product) => [product.title, product.short_description, product.category, ...product.tags].join(' ').toLowerCase().includes(query));
  }
  if (req.query.category) products = products.filter((product) => product.category === req.query.category);
  if (req.query.type) products = products.filter((product) => product.type === req.query.type);
  if (req.query.sort === 'price_asc') products.sort((a, b) => a.price - b.price);
  if (req.query.sort === 'price_desc') products.sort((a, b) => b.price - a.price);
  const categories = [...new Set(activeProducts(db).map((product) => product.category))];
  const types = [...new Set(activeProducts(db).map((product) => product.type))];
  res.render('catalog', { title: 'Каталог', products, categories, types, query: req.query });
});

app.get('/products/:id', (req, res) => {
  const db = store.read();
  const product = db.products.find((item) => item.id === req.params.id && item.status === 'active');
  if (!product) return res.status(404).render('error', { title: 'Товар не найден', message: 'Такого товара или услуги нет в активном каталоге.' });
  const detailed = store.productWithSeller(db, product);
  const related = activeProducts(db).filter((item) => item.id !== product.id && item.category === product.category).slice(0, 3);
  res.render('product', { title: detailed.title, product: detailed, related });
});

app.post('/orders', (req, res) => {
  if (!req.session.user) {
    flash(req, 'error', 'Войдите как клиент, чтобы оформить покупку.');
    return res.redirect('/login?role=client');
  }
  if (req.session.user.role !== 'client') {
    flash(req, 'error', 'Покупку можно оформить из кабинета клиента.');
    return res.redirect(`/${req.session.user.role}`);
  }
  const created = store.update((db) => {
    const product = db.products.find((item) => item.id === req.body.product_id && item.status === 'active');
    if (!product) return null;
    if (product.stock > 0 && product.stock < 999) product.stock -= 1;
    const order = {
      id: store.id('order'),
      customer_id: req.session.user.id,
      product_id: product.id,
      seller_id: product.owner_id,
      amount: product.price,
      status: 'paid',
      source: req.body.referral_code ? `referral:${req.body.referral_code}` : 'site',
      created_at: store.nowIso()
    };
    db.orders.push(order);
    if (product.marketplace === 'trainer') {
      const reward = Math.round(product.price * 0.2);
      const profile = store.profileFor(db, product.owner_id);
      if (profile) profile.balance += product.price - Math.round(product.price * (db.meta.marketplace_commission_percent / 100));
      db.referrals.push({ id: store.id('ref'), trainer_id: product.owner_id, customer_id: req.session.user.id, order_id: order.id, reward, status: 'approved', created_at: store.nowIso() });
    }
    return order;
  });
  if (!created) {
    flash(req, 'error', 'Не удалось оформить заказ.');
    return res.redirect('/catalog');
  }
  flash(req, 'success', 'Заказ оплачен в демо-режиме. Материалы доступны в кабинете.');
  res.redirect('/client');
});

app.get('/login', (req, res) => {
  res.render('login', { title: 'Вход', role: req.query.role || 'client' });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const db = store.read();
  const user = db.users.find((item) => item.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    flash(req, 'error', 'Неверный email или пароль.');
    return res.redirect('/login');
  }
  if (user.is_blocked) {
    flash(req, 'error', 'Пользователь заблокирован администратором.');
    return res.redirect('/login');
  }
  req.session.user = store.userWithProfile(db, user);
  res.redirect(`/${user.role}`);
});

app.post('/register', (req, res) => {
  const role = req.body.role === 'trainer' ? 'trainer' : 'client';
  const created = store.update((db) => {
    if (db.users.some((user) => user.email.toLowerCase() === String(req.body.email || '').toLowerCase())) return null;
    const user = {
      id: store.id('user'),
      email: req.body.email,
      password_hash: bcrypt.hashSync(req.body.password || 'password123', 10),
      role,
      is_blocked: false,
      created_at: store.nowIso()
    };
    db.users.push(user);
    db.profiles.push({
      user_id: user.id,
      full_name: req.body.full_name,
      phone: req.body.phone || '',
      city: req.body.city || '',
      specialization: req.body.specialization || '',
      avatar_url: '',
      rating: 0,
      referral_code: role === 'trainer' ? String(req.body.full_name || 'FIT').toUpperCase().replace(/[^A-ZА-Я0-9]/g, '').slice(0, 10) || store.id('ref').slice(0, 8) : '',
      balance: 0
    });
    return user;
  });
  if (!created) {
    flash(req, 'error', 'Такой email уже зарегистрирован.');
    return res.redirect(`/login?role=${role}`);
  }
  flash(req, 'success', 'Регистрация завершена. Теперь можно войти.');
  res.redirect(`/login?role=${role}`);
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/client', requireRole('client'), (req, res) => {
  const db = store.read();
  const orders = db.orders.filter((order) => order.customer_id === req.session.user.id).map((order) => orderWithDetails(db, order)).reverse();
  res.render('client/dashboard', {
    title: 'Кабинет клиента',
    orders,
    subscriptions: db.subscriptions,
    recommendations: activeProducts(db).slice(0, 4)
  });
});

app.get('/client/workouts', requireRole('client'), (req, res) => {
  const db = store.read();
  res.render('client/workouts', {
    title: 'Мои тренировки',
    program: currentProgramForClient(db, req.session.user.id)
  });
});

app.get('/client/progress', requireRole('client'), (req, res) => {
  const db = store.read();
  const progress = db.progress_reports
    .filter((item) => item.client_id === req.session.user.id)
    .sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  res.render('client/progress', { title: 'Дневник прогресса', progress });
});

app.post('/client/progress', requireRole('client'), (req, res) => {
  store.update((db) => {
    const trainer = primaryTrainerForClient(db, req.session.user.id);
    db.progress_reports.push({
      id: store.id('progress'),
      trainer_id: trainer.id,
      client_id: req.session.user.id,
      report_date: req.body.report_date,
      weight: Number(req.body.weight || 0),
      measurements: {
        waist: req.body.waist || '',
        hips: req.body.hips || '',
        chest: req.body.chest || '',
        arms: req.body.arms || '',
        legs: req.body.legs || ''
      },
      photo_before: uploadUrl(fileByField(req, 'photo_before')),
      photo_after: uploadUrl(fileByField(req, 'photo_after')),
      notes: req.body.notes || '',
      created_at: store.nowIso()
    });
  });
  flash(req, 'success', 'Замеры сохранены.');
  res.redirect('/client/progress');
});

app.get('/client/payments', requireRole('client'), (req, res) => {
  const db = store.read();
  const orderPayments = db.orders
    .filter((order) => order.customer_id === req.session.user.id)
    .map((order) => ({ id: order.id, payment_date: order.created_at.slice(0, 10), amount: order.amount, payment_method: 'Демо-оплата', comment: orderWithDetails(db, order).product?.title || 'Заказ' }));
  const payments = db.payments
    .filter((pay) => pay.client_id === req.session.user.id)
    .concat(orderPayments)
    .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)));
  res.render('client/payments', { title: 'Оплаты', payments });
});

app.get('/client/chat', requireRole('client'), (req, res) => {
  const db = store.read();
  const trainer = primaryTrainerForClient(db, req.session.user.id);
  const messages = db.messages
    .filter((msg) => [msg.sender_id, msg.recipient_id].includes(req.session.user.id) && [msg.sender_id, msg.recipient_id].includes(trainer.id))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  res.render('client/chat', { title: 'Чат с тренером', trainer, messages });
});

app.post('/client/chat', requireRole('client'), (req, res) => {
  store.update((db) => {
    const trainer = primaryTrainerForClient(db, req.session.user.id);
    db.messages.push({
      id: store.id('message'),
      trainer_id: trainer.id,
      sender_id: req.session.user.id,
      recipient_id: trainer.id,
      message_text: req.body.message_text,
      file_attachment: uploadUrl(fileByField(req, 'attachment')),
      created_at: store.nowIso()
    });
  });
  res.redirect('/client/chat');
});

app.get('/trainer', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const products = db.products.filter((product) => product.owner_id === req.session.user.id).map((product) => store.productWithSeller(db, product));
  const orders = db.orders.filter((order) => order.seller_id === req.session.user.id).map((order) => orderWithDetails(db, order)).reverse();
  const referrals = db.referrals.filter((ref) => ref.trainer_id === req.session.user.id);
  const clients = db.clients.filter((client) => client.trainer_id === req.session.user.id);
  const profile = store.profileFor(db, req.session.user.id);
  const revenue = orders.reduce((sum, order) => sum + Number(order.amount), 0);
  res.render('trainer/dashboard', {
    title: 'Кабинет тренера',
    products,
    orders,
    referrals,
    clients,
    profile,
    revenue,
    commission: db.meta.marketplace_commission_percent
  });
});

app.post('/trainer/products', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.products.push({
      id: store.id('product'),
      owner_id: req.session.user.id,
      title: req.body.title,
      type: req.body.type,
      category: req.body.category,
      price: Number(req.body.price || 0),
      old_price: 0,
      stock: Number(req.body.stock || 999),
      status: 'moderation',
      marketplace: 'trainer',
      image_url: req.body.image_url || 'https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=1200&q=85',
      short_description: req.body.short_description,
      description: req.body.description,
      tags: String(req.body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      yandex_sync: 'manual'
    });
  });
  flash(req, 'success', 'Товар отправлен на модерацию маркетплейса.');
  res.redirect('/trainer');
});

app.post('/trainer/payouts', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.payout_requests.push({
      id: store.id('payout'),
      trainer_id: req.session.user.id,
      amount: Number(req.body.amount || 0),
      status: 'pending',
      method: req.body.method || 'Карта',
      created_at: store.nowIso()
    });
  });
  flash(req, 'success', 'Заявка на вывод средств создана.');
  res.redirect('/trainer');
});

app.get('/trainer/clients', requireRole('trainer'), (req, res) => {
  const db = store.read();
  let clients = trainerClients(db, req.session.user.id);
  const query = req.query;
  const search = String(query.q || '').trim().toLowerCase();
  if (search) clients = clients.filter((client) => client.full_name.toLowerCase().includes(search) || client.email.toLowerCase().includes(search));
  if (query.status) clients = clients.filter((client) => client.status === query.status);
  clients.sort((a, b) => query.sort === 'status' ? a.status.localeCompare(b.status) : a.full_name.localeCompare(b.full_name));
  res.render('trainer/clients', { title: 'Клиенты', clients, query });
});

app.post('/trainer/clients', requireRole('trainer'), (req, res) => {
  const created = store.update((db) => {
    if (db.users.some((user) => user.email.toLowerCase() === String(req.body.email || '').toLowerCase())) return null;
    const user = {
      id: store.id('user'),
      email: req.body.email,
      password_hash: bcrypt.hashSync(req.body.password || 'password123', 10),
      role: 'client',
      is_blocked: false,
      created_at: store.nowIso()
    };
    db.users.push(user);
    db.profiles.push({
      user_id: user.id,
      full_name: req.body.full_name,
      phone: req.body.phone || '',
      city: '',
      specialization: '',
      avatar_url: '',
      rating: 0,
      referral_code: '',
      balance: 0
    });
    db.clients.push({
      id: store.id('client'),
      trainer_id: req.session.user.id,
      customer_id: user.id,
      birth_date: req.body.birth_date || '',
      status: req.body.status || 'active',
      notes: req.body.notes || '',
      goal: 'Новая цель',
      progress: 'Пока без замеров',
      next_session: ''
    });
    return user;
  });
  flash(req, created ? 'success' : 'error', created ? 'Клиент добавлен.' : 'Такой email уже зарегистрирован.');
  res.redirect('/trainer/clients');
});

app.get('/trainer/clients/export', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const rows = [['ФИО', 'Email', 'Телефон', 'Статус', 'Заметки']]
    .concat(trainerClients(db, req.session.user.id).map((client) => [client.full_name, client.email, client.phone, client.status, client.notes]));
  csvResponse(res, 'clients.csv', rows);
});

app.get('/trainer/clients/:id', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const client = trainerClients(db, req.session.user.id).find((item) => item.user_id === req.params.id);
  if (!client) return res.status(404).render('error', { title: 'Клиент не найден', message: 'Клиент не привязан к вашему кабинету.' });
  const progress = db.progress_reports.filter((item) => item.client_id === client.user_id).sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  const payments = db.payments.filter((item) => item.client_id === client.user_id && item.trainer_id === req.session.user.id);
  const events = db.calendar_events.filter((item) => item.client_id === client.user_id && item.trainer_id === req.session.user.id);
  res.render('trainer/client', {
    title: client.full_name,
    member: client,
    program: currentProgramForClient(db, client.user_id),
    progress,
    payments,
    events
  });
});

app.post('/trainer/clients/:id', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    const client = db.clients.find((item) => item.trainer_id === req.session.user.id && (item.customer_id || item.user_id) === req.params.id);
    const user = db.users.find((item) => item.id === req.params.id);
    const profile = store.profileFor(db, req.params.id);
    if (client) {
      client.birth_date = req.body.birth_date || '';
      client.status = req.body.status || 'active';
      client.notes = req.body.notes || '';
    }
    if (user) user.email = req.body.email;
    if (profile) {
      profile.full_name = req.body.full_name;
      profile.phone = req.body.phone || '';
    }
  });
  flash(req, 'success', 'Карточка клиента обновлена.');
  res.redirect(`/trainer/clients/${req.params.id}`);
});

app.get('/trainer/exercises', requireRole('trainer'), (req, res) => {
  const db = store.read();
  res.render('trainer/exercises', {
    title: 'Упражнения',
    ownExercises: db.exercises.filter((exercise) => exercise.owner_id === req.session.user.id),
    publicExercises: db.exercises.filter((exercise) => exercise.is_public)
  });
});

app.post('/trainer/exercises', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.exercises.push({
      id: store.id('exercise'),
      owner_id: req.session.user.id,
      name: req.body.name,
      muscle_group: req.body.muscle_group,
      image_url: req.body.image_url || '/assets/placeholder.svg',
      video_url: req.body.video_url || '',
      description: req.body.description,
      technique: req.body.technique || '',
      is_public: false
    });
  });
  flash(req, 'success', 'Упражнение добавлено.');
  res.redirect('/trainer/exercises');
});

app.get('/trainer/programs', requireRole('trainer'), (req, res) => {
  const db = store.read();
  res.render('trainer/programs', {
    title: 'Программы',
    exercises: db.exercises.filter((exercise) => exercise.is_public || exercise.owner_id === req.session.user.id),
    programs: db.programs.filter((program) => program.trainer_id === req.session.user.id),
    clients: trainerClients(db, req.session.user.id)
  });
});

app.post('/trainer/programs', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    const exerciseIds = Array.isArray(req.body.exercise_id) ? req.body.exercise_id : [req.body.exercise_id];
    const sets = Array.isArray(req.body.sets) ? req.body.sets : [req.body.sets];
    const reps = Array.isArray(req.body.reps) ? req.body.reps : [req.body.reps];
    const rests = Array.isArray(req.body.rest_seconds) ? req.body.rest_seconds : [req.body.rest_seconds];
    const videos = Array.isArray(req.body.video_url) ? req.body.video_url : [req.body.video_url];
    const exercises = exerciseIds.filter(Boolean).map((exerciseId, index) => ({
      exercise_id: exerciseId,
      sets: Number(sets[index] || 3),
      reps: reps[index] || '10',
      rest_seconds: Number(rests[index] || 60),
      video_url: videos[index] || ''
    }));
    db.programs.push({
      id: store.id('program'),
      trainer_id: req.session.user.id,
      name: req.body.name,
      description: req.body.description || '',
      duration_days: Number(req.body.duration_days || 28),
      workouts: [{
        id: store.id('workout'),
        day_label: req.body.day_label || 'День 1',
        name: req.body.workout_name || 'Тренировка',
        description: req.body.workout_description || '',
        exercises
      }]
    });
  });
  flash(req, 'success', 'Программа сохранена.');
  res.redirect('/trainer/programs');
});

app.post('/trainer/programs/:id/assign', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.program_assignments
      .filter((item) => item.trainer_id === req.session.user.id && item.client_id === req.body.client_id)
      .forEach((item) => { item.status = 'archived'; });
    db.program_assignments.push({
      id: store.id('assignment'),
      trainer_id: req.session.user.id,
      client_id: req.body.client_id,
      program_id: req.params.id,
      assigned_at: req.body.assigned_at || new Date().toISOString().slice(0, 10),
      expires_at: req.body.expires_at || addDays(req.body.assigned_at, 28),
      status: 'active'
    });
  });
  flash(req, 'success', 'Программа назначена клиенту.');
  res.redirect('/trainer/programs');
});

app.post('/trainer/programs/:id/delete', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.programs = db.programs.filter((program) => !(program.id === req.params.id && program.trainer_id === req.session.user.id));
    db.program_assignments.forEach((assignment) => {
      if (assignment.program_id === req.params.id && assignment.trainer_id === req.session.user.id) assignment.status = 'archived';
    });
  });
  flash(req, 'success', 'Программа удалена.');
  res.redirect('/trainer/programs');
});

app.get('/trainer/calendar', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const events = db.calendar_events
    .filter((event) => event.trainer_id === req.session.user.id)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  res.render('trainer/calendar', { title: 'Календарь', clients: trainerClients(db, req.session.user.id), events });
});

app.post('/trainer/events', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.calendar_events.push({
      id: store.id('event'),
      trainer_id: req.session.user.id,
      client_id: req.body.client_id,
      title: req.body.title,
      event_type: req.body.event_type,
      start_time: req.body.start_time,
      end_time: req.body.end_time,
      status: 'planned',
      created_at: store.nowIso()
    });
  });
  flash(req, 'success', 'Событие создано.');
  res.redirect('/trainer/calendar');
});

app.post('/trainer/events/:id/done', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    const event = db.calendar_events.find((item) => item.id === req.params.id && item.trainer_id === req.session.user.id);
    if (event) event.status = 'done';
  });
  res.redirect('/trainer/calendar');
});

app.post('/trainer/events/:id/copy', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    const event = db.calendar_events.find((item) => item.id === req.params.id && item.trainer_id === req.session.user.id);
    if (event) {
      db.calendar_events.push({
        ...event,
        id: store.id('event'),
        start_time: new Date(new Date(event.start_time).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
        end_time: new Date(new Date(event.end_time).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
        status: 'planned',
        created_at: store.nowIso()
      });
    }
  });
  res.redirect('/trainer/calendar');
});

app.get('/trainer/finance', requireRole('trainer'), (req, res) => {
  const db = store.read();
  let payments = db.payments.filter((pay) => pay.trainer_id === req.session.user.id);
  if (req.query.from) payments = payments.filter((pay) => pay.payment_date >= req.query.from);
  if (req.query.to) payments = payments.filter((pay) => pay.payment_date <= req.query.to);
  const total = payments.reduce((sum, pay) => sum + Number(pay.amount || 0), 0);
  res.render('trainer/finance', { title: 'Финансы', clients: trainerClients(db, req.session.user.id), payments, total, query: req.query });
});

app.post('/trainer/payments', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.payments.push({
      id: store.id('payment'),
      trainer_id: req.session.user.id,
      client_id: req.body.client_id,
      amount: Number(req.body.amount || 0),
      payment_date: req.body.payment_date,
      payment_method: req.body.payment_method || 'Карта',
      comment: req.body.comment || '',
      created_at: store.nowIso()
    });
  });
  flash(req, 'success', 'Оплата добавлена.');
  res.redirect('/trainer/finance');
});

app.get('/trainer/finance/export', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const clients = trainerClients(db, req.session.user.id);
  const rows = [['Клиент', 'Дата', 'Метод', 'Комментарий', 'Сумма']]
    .concat(db.payments.filter((pay) => pay.trainer_id === req.session.user.id).map((pay) => {
      const client = clients.find((item) => item.user_id === pay.client_id);
      return [client?.full_name || 'Клиент', pay.payment_date, pay.payment_method, pay.comment, pay.amount];
    }));
  csvResponse(res, 'payments.csv', rows);
});

app.get('/trainer/chat', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const clients = trainerClients(db, req.session.user.id);
  const selected = req.query.client || clients[0]?.user_id || '';
  const messages = db.messages
    .filter((msg) => [msg.sender_id, msg.recipient_id].includes(req.session.user.id) && [msg.sender_id, msg.recipient_id].includes(selected))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  res.render('trainer/chat', { title: 'Чат', clients, selected, messages });
});

app.post('/trainer/chat', requireRole('trainer'), (req, res) => {
  store.update((db) => {
    db.messages.push({
      id: store.id('message'),
      trainer_id: req.session.user.id,
      sender_id: req.session.user.id,
      recipient_id: req.body.recipient_id,
      message_text: req.body.message_text,
      file_attachment: uploadUrl(fileByField(req, 'attachment')),
      created_at: store.nowIso()
    });
  });
  res.redirect(`/trainer/chat?client=${encodeURIComponent(req.body.recipient_id)}`);
});

app.get('/trainer/reports', requireRole('trainer'), (req, res) => {
  const db = store.read();
  res.render('trainer/reports', { title: 'Отчеты', clients: trainerClients(db, req.session.user.id), db });
});

app.get('/trainer/reports/:id.pdf', requireRole('trainer'), (req, res) => {
  const db = store.read();
  const client = trainerClients(db, req.session.user.id).find((item) => item.user_id === req.params.id);
  if (!client) return res.status(404).render('error', { title: 'Отчет не найден', message: 'Клиент не найден.' });
  const progress = db.progress_reports.filter((item) => item.client_id === client.user_id).sort((a, b) => String(a.report_date).localeCompare(String(b.report_date)));
  const doc = new PDFDocument({ margin: 48 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${client.user_id}-report.pdf"`);
  doc.pipe(res);
  doc.fontSize(18).text(`SportShopFitness report: ${client.full_name}`);
  doc.moveDown();
  doc.fontSize(12).text(`Status: ${client.status}`);
  doc.text(`Phone: ${client.phone || '-'}`);
  doc.text(`Notes: ${client.notes || '-'}`);
  doc.moveDown();
  progress.forEach((item) => {
    doc.text(`${item.report_date}: weight ${item.weight} kg, waist ${item.measurements.waist || '-'} cm`);
  });
  doc.end();
});

app.get('/admin', requireRole('admin'), (req, res) => {
  const db = store.read();
  const products = db.products.map((product) => store.productWithSeller(db, product));
  const orders = db.orders.map((order) => orderWithDetails(db, order)).reverse();
  res.render('admin/dashboard', {
    title: 'Админка маркетплейса',
    products,
    orders,
    users: db.users.map((user) => store.userWithProfile(db, user)),
    payouts: db.payout_requests,
    marketSync: db.market_sync,
    subscriptions: db.subscriptions
  });
});

app.post('/admin/products/:id/status', requireRole('admin'), (req, res) => {
  store.update((db) => {
    const product = db.products.find((item) => item.id === req.params.id);
    if (product) product.status = req.body.status;
  });
  flash(req, 'success', 'Статус товара обновлен.');
  res.redirect('/admin');
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', storage: store.status() });
});

app.use((req, res) => {
  res.status(404).render('error', { title: 'Страница не найдена', message: 'Раздел еще не создан или адрес указан неверно.' });
});

async function start() {
  await store.ready();
  return app;
}

if (require.main === module) {
  start()
    .then(() => {
      app.listen(port, () => {
        console.log(`SportShopFitness running at http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error(`Failed to initialize storage: ${error.message}`);
      process.exit(1);
    });
}

module.exports = app;
module.exports.app = app;
module.exports.start = start;
