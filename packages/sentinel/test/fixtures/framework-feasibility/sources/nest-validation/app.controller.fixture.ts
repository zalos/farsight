// Synthetic Sentinel E2 fixture (nest-validation). Original, inert, never installed outside a bounded
// probe container. Demonstrates that a decorated DTO parameter type is a declaration, not enforcement:
// only a route that actually registers a ValidationPipe rejects a request that fails the DTO's rules.
import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { CreateUserDto } from './create-user.dto';

@Controller('users')
export class AppController {
  // validator-with-pipe: an explicit, route-scoped ValidationPipe actually enforces the declared DTO.
  @Post('validated')
  @UsePipes(new ValidationPipe({ whitelist: true }))
  createValidated(@Body() dto: CreateUserDto) {
    return { ok: true, dto };
  }

  // validator-without-pipe: the same DTO type is declared as the parameter, but no pipe is registered
  // for this route and none is registered globally, so the shape is documentation only at request time.
  @Post('unvalidated')
  createUnvalidated(@Body() dto: CreateUserDto) {
    return { ok: true, dto };
  }
}
