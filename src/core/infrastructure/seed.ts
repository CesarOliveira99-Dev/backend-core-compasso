import { IdentityService } from '../../modules/identity/identity.module.js';
import { Context, timestamp } from '../application/context.js';
import type { Appointment, CatalogItem, Customer, Feedback, Order } from '../domain/models.js';
import { localDate } from '../domain/policies.js';
export function seedDemo(context: Context, identity: IdentityService) {
  if (process.env.SEED_DEMO !== 'true') return;
  if (process.env.NODE_ENV === 'production')
    throw new Error('Demo data must not be enabled in production.');
  if (context.repository.get('system', 'stores', 'studio')) return;
  const { user: admin } = identity.register({
    role: 'admin',
    slug: 'studio',
    email: 'admin@compasso.local',
    password: 'Compasso@2026',
    name: 'Marina Oliveira',
    phone: '5511999990000',
    businessName: 'Estúdio Aurora',
  });
  const names = [
    'Júlia Martins',
    'Camila Rodrigues',
    'Beatriz Santos',
    'Ana Paula Costa',
    'Larissa Almeida',
  ];
  const customers = names.map(
    (name, index) =>
      identity.register({
        role: 'customer',
        slug: 'studio',
        email: index === 0 ? 'cliente@compasso.local' : `cliente${index}@compasso.local`,
        password: 'Compasso@2026',
        name,
        phone: `551199999000${index + 1}`,
      }).user,
  );
  const customer = context.require<Customer>(admin, 'customers', customers[0].id);
  customer.addresses = [
    {
      id: 'demo-address',
      label: 'Casa',
      street: 'Rua das Flores',
      number: '120',
      city: 'São Paulo',
      postalCode: '01310-100',
      isDefault: true,
    },
  ];
  context.repository.put(admin.tenantId, 'customers', customer.id, customer);
  const catalog: CatalogItem[] = [
    {
      id: 'personal-care',
      name: 'Cuidado essencial',
      description:
        'Uma pausa para você. Atendimento personalizado com avaliação das suas necessidades.',
      kind: 'service',
      category: 'Bem-estar',
      priceCents: 12000,
      durationMinutes: 60,
      requiresTriage: false,
      active: true,
    },
    {
      id: 'relaxation',
      name: 'Sessão de relaxamento',
      description: 'Renove suas energias com um cuidado completo, no seu ritmo.',
      kind: 'service',
      category: 'Bem-estar',
      priceCents: 18000,
      durationMinutes: 90,
      requiresTriage: false,
      active: true,
    },
    {
      id: 'consultation',
      name: 'Avaliação personalizada',
      description: 'Conte o que você precisa. Vamos avaliar sua solicitação antes de confirmar.',
      kind: 'service',
      category: 'Consultoria',
      priceCents: 8000,
      durationMinutes: 30,
      requiresTriage: true,
      active: true,
    },
    {
      id: 'care-kit',
      name: 'Kit autocuidado',
      description: 'Pequenos cuidados que fazem diferença na sua rotina. Entregue no seu endereço.',
      kind: 'product',
      category: 'Autocuidado',
      priceCents: 8900,
      durationMinutes: 0,
      requiresTriage: false,
      active: true,
    },
    {
      id: 'essential-oil',
      name: 'Óleo essencial',
      description: 'Um toque de calma para acompanhar seus momentos de descanso.',
      kind: 'product',
      category: 'Autocuidado',
      priceCents: 4900,
      durationMinutes: 0,
      requiresTriage: false,
      active: true,
    },
  ];
  catalog.forEach((item) => context.repository.put(admin.tenantId, 'catalog', item.id, item));
  const today = localDate(new Date());
  const putAppointment = (
    recordId: string,
    date: string,
    hour: number,
    index: number,
    status: Appointment['status'],
    itemIndex = 0,
  ) => {
    const item = catalog[itemIndex];
    const start = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00-03:00`);
    const end = new Date(start.getTime() + item.durationMinutes * 60000);
    const appointment: Appointment = {
      id: recordId,
      customerId: customers[index].id,
      customerName: customers[index].name,
      itemId: item.id,
      itemName: item.name,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      priceCents: item.priceCents,
      status,
      paymentStatus: status === 'completed' ? 'paid' : 'pending',
      notes: '',
      createdAt: start.toISOString(),
      ...(status === 'completed'
        ? { completedAt: end.toISOString(), paidAt: end.toISOString() }
        : {}),
    };
    context.repository.put(admin.tenantId, 'appointments', recordId, appointment);
    return appointment;
  };
  for (let day = 1; day <= 6; day++) {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - day);
    const key = date.toISOString().slice(0, 10);
    for (let visit = 0; visit < 3; visit++)
      putAppointment(
        `history-${day}-${visit}`,
        key,
        9 + visit * 2,
        (day + visit) % 5,
        'completed',
        visit % 2,
      );
  }
  putAppointment('today-one', today, 9, 1, 'completed');
  putAppointment('today-two', today, 11, 2, 'completed', 1);
  putAppointment('today-three', today, 15, 0, 'confirmed');
  putAppointment('today-four', today, 17, 3, 'confirmed');
  const future = new Date(`${today}T12:00:00Z`);
  future.setUTCDate(future.getUTCDate() + 1);
  putAppointment('tomorrow-one', future.toISOString().slice(0, 10), 10, 0, 'confirmed', 1);
  future.setUTCDate(future.getUTCDate() + 2);
  putAppointment('future-one', future.toISOString().slice(0, 10), 14, 4, 'confirmed');
  const triageAppointment = putAppointment(
    'triage-one',
    future.toISOString().slice(0, 10),
    16,
    0,
    'pending',
    2,
  );
  context.repository.put(admin.tenantId, 'triage', 'triage-one', {
    id: 'triage-one',
    customerId: customers[0].id,
    customerName: customers[0].name,
    appointmentId: triageAppointment.id,
    answers:
      'Gostaria de uma orientação para escolher o cuidado mais adequado à minha rotina. Tenho disponibilidade à tarde.',
    status: 'pending',
    decision: '',
    createdAt: timestamp(),
  });
  const order: Order = {
    id: 'demo-order',
    customerId: customers[0].id,
    customerName: customers[0].name,
    items: [
      {
        itemId: catalog[3].id,
        name: catalog[3].name,
        quantity: 1,
        kind: 'product',
        unitPriceCents: catalog[3].priceCents,
      },
    ],
    totalCents: catalog[3].priceCents,
    discountCents: 0,
    status: 'pending',
    paymentStatus: 'pending',
    paymentMethod: 'on_day',
    address: customer.addresses[0],
    seen: false,
    createdAt: timestamp(),
  };
  context.repository.put(admin.tenantId, 'orders', order.id, order);
  const feedback: Feedback = {
    id: 'demo-feedback',
    customerId: customers[1].id,
    customerName: customers[1].name,
    appointmentId: 'today-one',
    rating: 5,
    comment:
      'Uma experiência maravilhosa! O cuidado com cada detalhe fez toda a diferença. Já quero voltar.',
    reply: '',
    createdAt: timestamp(),
  };
  context.repository.put(admin.tenantId, 'feedback', feedback.id, feedback);
  context.notify(
    admin,
    admin.id,
    'Seu espaço está pronto',
    'Estes são dados de demonstração. Explore o Compasso e conheça sua nova rotina.',
  );
  context.notify(
    admin,
    customers[0].id,
    'Bem-vinda ao Estúdio Aurora',
    'Seus cuidados, pedidos e próximos encontros estão todos aqui.',
  );
}
