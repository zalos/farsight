// Synthetic Sentinel E2 fixture (nest-validation). Original, inert, never installed outside a bounded
// probe container.
import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  name!: string;

  @IsEmail()
  email!: string;
}
