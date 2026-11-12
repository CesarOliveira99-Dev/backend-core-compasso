import { ServiceUnavailableException } from '@nestjs/common';
/** A definitive rejection is different from a request whose outcome was lost. */
export class PaymentProviderRejected extends ServiceUnavailableException {}
