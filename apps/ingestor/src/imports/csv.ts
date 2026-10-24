// Разбор CSV без библиотеки: файлы выгрузки — это запятая и кавычки, больше
// ничего. Библиотека здесь принесла бы диалекты, которых в этих файлах нет,
// а кавычки умещаются в десять строк.
//
// Первая строка выгрузки Bybit — не заголовок, а подпись вида
// «UID: 624707,Company Name: ,Country: ». Её отбрасывает вызывающий.
export function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quoted) {
      // Две кавычки внутри кавычек — это одна кавычка в значении.
      if (char === '"' && line[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      cells.push(cell.trim())
      cell = ''
    } else cell += char
  }
  cells.push(cell.trim())
  return cells
}

// Строки файла как словари по заголовку. Пустые строки пропускаются: в хвосте
// выгрузки они бывают.
export function readCsv(text: string, headerLine: number): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const header = splitCsvLine(lines[headerLine] ?? '')
  return lines.slice(headerLine + 1).map((line) => {
    const cells = splitCsvLine(line)
    return Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']))
  })
}
