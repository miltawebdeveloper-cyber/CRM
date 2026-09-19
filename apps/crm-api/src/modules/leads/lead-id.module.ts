import { Module } from '@nestjs/common';
import { LeadIdService } from './lead-id.service.js';

/**
 * Lead ID generation on its own, so any module that creates a lead can import it
 * without pulling in LeadsService — and therefore without dragging in Quo,
 * notifications, and a dependency cycle. Communications creates leads from
 * unrecognised inbound callers and needs exactly this and nothing else.
 */
@Module({
  providers: [LeadIdService],
  exports: [LeadIdService],
})
export class LeadIdModule {}
