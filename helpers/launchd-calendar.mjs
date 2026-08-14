export function launchdCalendarXml(seconds) {
  const minutes = seconds / 60;
  let slots;

  if (1440 % minutes === 0) {
    slots = Array.from({ length: 1440 / minutes }, (_, index) => fields(index * minutes));
  } else if (minutes <= 10080) {
    slots = [];
    for (let offset = 0; offset < 10080; offset += minutes) {
      slots.push({ Weekday: Math.floor(offset / 1440), ...fields(offset % 1440) });
    }
  } else {
    const days = Math.max(1, Math.floor(minutes / 1440));
    slots = [];
    for (let day = 1; day <= 31; day += days) slots.push({ Day: day, Hour: 0, Minute: 0 });
  }

  return `<array>\n${slots.map(dict).join('\n')}\n  </array>`;
}

function fields(minutes) {
  return { Hour: Math.floor(minutes / 60), Minute: minutes % 60 };
}

function dict(values) {
  const fields = Object.entries(values)
    .map(([key, value]) => `      <key>${key}</key><integer>${value}</integer>`)
    .join('\n');
  return `    <dict>\n${fields}\n    </dict>`;
}
