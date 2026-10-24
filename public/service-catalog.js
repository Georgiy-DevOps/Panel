export const services = [
  {
    id: 'maintenance',
    name: 'Техническое обслуживание',
    description: 'Плановое ТО, осмотр и обслуживание автомобиля.',
    icon: '01',
  },
  {
    id: 'diagnostics',
    name: 'Диагностика',
    description: 'Ошибки, неисправности и проверка состояния автомобиля.',
    icon: '02',
  },
  {
    id: 'setup',
    name: 'Настройка автомобиля',
    description: 'Русский язык, магазин приложений и помощь с настройками.',
    icon: '03',
  },
  {
    id: 'consultation',
    name: 'Консультация',
    description: 'Поможем разобраться с автомобилем и выбрать нужную услугу.',
    icon: '04',
  },
];
export const statuses = {
  new: 'На рассмотрении',
  confirmed: 'Визит подтверждён',
  in_progress: 'В работе',
  completed: 'Завершена',
  cancelled: 'Отменена',
};
export const transitions = {
  new: ['new', 'confirmed', 'cancelled'],
  confirmed: ['confirmed', 'in_progress', 'cancelled'],
  in_progress: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
export const activeStatuses = ['new', 'confirmed', 'in_progress'];
export const moscowDate = (time = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(time);
