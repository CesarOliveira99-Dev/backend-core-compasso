export function personNameError(value: string): string {
  const name = value.normalize('NFC').trim();
  if (!name) return 'Informe seu nome.';
  if (/\p{N}/u.test(name)) return 'Seu nome não pode conter números.';
  if (name.length > 100) return 'Seu nome deve ter no máximo 100 caracteres.';
  if (!/^[\p{L}\p{M} .\u2019'-]+$/u.test(name)) return 'Use apenas letras, espaços, apóstrofos, pontos ou hífens no nome.';
  if ((name.match(/\p{L}/gu) || []).length < 2) return 'Informe um nome com pelo menos duas letras.';
  return '';
}
export function phoneError(value: string): string {
  const phone = value.trim(), digits = phone.replace(/\D/g, '');
  if (!phone) return 'Informe seu telefone.';
  if (phone.length > 20 || digits.length > 13 || (digits.length > 11 && !digits.startsWith('55'))) return 'Telefone acima do limite: use até 11 dígitos com DDD, ou 13 incluindo o código 55.';
  if (!/^[+\d\s().-]+$/.test(phone)) return 'Use apenas números e os sinais de formatação do telefone.';
  const national = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
  if (!/^[1-9]{2}\d{8,9}$/.test(national)) return 'Informe o DDD e um telefone de 8 ou 9 dígitos. O código +55 é opcional.';
  return '';
}
