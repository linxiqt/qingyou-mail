// POP3 sizes include canonical CRLF endings and exclude transmission dot stuffing.
export function popOctets(bytes) {
  let size = bytes.length;
  for (let i = bytes.indexOf(10); i !== -1; i = bytes.indexOf(10, i + 1))
    if (i === 0 || bytes[i - 1] !== 13) size++;
  for (let i = bytes.indexOf(13); i !== -1; i = bytes.indexOf(13, i + 1))
    if (bytes[i + 1] !== 10) size++;
  const last = bytes.at(-1);
  return size + (size && last !== 13 && last !== 10 ? 2 : 0);
}
