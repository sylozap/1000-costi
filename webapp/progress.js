// Единое описание отметок шкалы и доступной текстовой расшифровки.
export function progressFeatures(r) {
  const features = [];
  if (r.pits_on) for (const [start, end] of r.pits || []) {
    features.push({ kind: 'pit', start, end, label: `🕳 Яма ${start}–${end - 1}: чтобы выбраться, нужно за один ход достичь ${end}.` });
  }
  if (r.samosval_on) features.push({ kind: 'truck', start: r.samosval,
    label: `🚛 Самосвал ${r.samosval}: попадание ровно на это число обнуляет счёт.` });
  if (r.barrel === 'points' || r.barrel === 'knock') features.push({ kind: 'barrel', start: r.barrel_start, end: 1000,
    label: `🛢 Бочка с ${r.barrel_start}: число попыток — ${r.barrel_attempts}, нужно добрать до 1000 за один ход.${r.barrel === 'knock' ? ' Новый игрок сбрасывает предыдущего с бочки.' : ''}` });
  if (r.barrel === 'open') features.push({ kind: 'finish', start: 1000,
    label: '🏁 Финиш ровно на 1000: перебор сжигает ход и добавляет точку.' });
  return features;
}
