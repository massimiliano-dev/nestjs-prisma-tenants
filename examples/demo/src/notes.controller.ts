import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { InjectTenantClient, TenantClientService } from '@massimiliano-dev/nestjs-prisma-tenants';
import type { PrismaClient } from './generated/prisma/client.js';

@Controller('notes')
export class NotesController {
  constructor(@InjectTenantClient() private readonly tenants: TenantClientService<PrismaClient>) {}

  @Get()
  async list() {
    const notes = await this.tenants.withClient((db) => db.note.findMany({ orderBy: { id: 'asc' } }));
    return { tenant: this.tenants.slug, notes };
  }

  @Post()
  async create(@Body() body: { title?: unknown }) {
    if (typeof body?.title !== 'string' || !body.title.trim())
      throw new BadRequestException('title is required');
    const title = body.title.trim();
    return this.tenants.withClient((db) => db.note.create({ data: { title } }));
  }
}
