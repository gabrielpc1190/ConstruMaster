import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import 'dotenv/config';

const prisma = new PrismaClient();

const USERS = [
  { username: 'gabriel',  fullName: 'Gabriel',         email: 'gabrielpc1190@gmail.com', role: 'admin'      },
  { username: 'diana',    fullName: 'Diana',           email: null,                       role: 'supervisor' },
  { username: 'tony',     fullName: 'Tony Vargas',     email: null,                       role: 'operativo'  },
  { username: 'adrian',   fullName: 'Adrián Vargas',   email: null,                       role: 'operativo'  },
  { username: 'nicholas', fullName: 'Nicholas Rowley', email: null,                       role: 'lector'     },
];

const BODEGAS = ['Cuarto Eléctrico GADI', 'Cuarto 4 del Bache', 'Bodega Baches'];

const MATERIALES_SEMILLA = [
  { tipo: 'material', nombreCanonico: 'Cemento UGC 50kg',      unidad: 'saco',    slug: 'cemento-ugc-50kg' },
  { tipo: 'material', nombreCanonico: 'Varilla #3 grado 40',    unidad: 'varilla', slug: 'varilla-3-grado-40' },
  { tipo: 'material', nombreCanonico: 'Varilla #4 grado 40',    unidad: 'varilla', slug: 'varilla-4-grado-40' },
  { tipo: 'material', nombreCanonico: 'Arena de río',           unidad: 'm3',      slug: 'arena-de-rio' },
  { tipo: 'material', nombreCanonico: 'Piedra cuarta',          unidad: 'm3',      slug: 'piedra-cuarta' },
  { tipo: 'material', nombreCanonico: 'Block 12x20x40',         unidad: 'unidad',  slug: 'block-12x20x40' },
  { tipo: 'servicio', nombreCanonico: 'Mano de obra albañilería', unidad: 'dia',   slug: 'mano-obra-albanileria' },
];

function gen(n = 20) {
  return crypto.randomBytes(24).toString('base64').replace(/[+/=]/g, '').slice(0, n);
}

async function upsertUser(spec) {
  const existing = await prisma.user.findUnique({ where: { username: spec.username } });
  if (existing) return { created: false, user: existing, password: null };

  const password = process.env[`SEED_${spec.username.toUpperCase()}_PW`] || gen(20);
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { ...spec, passwordHash, isActive: true },
  });
  return { created: true, user, password };
}

async function main() {
  console.log('Seeding ConstruMaster v2...');

  // Users
  const userResults = [];
  for (const spec of USERS) {
    userResults.push(await upsertUser(spec));
  }

  // Cliente Nicholas
  const cliente = await prisma.cliente.upsert({
    where: { id: 1n },
    update: {},
    create: { nombre: 'Nicholas Charles Rowley' },
  });

  // Bodegas
  for (const nombre of BODEGAS) {
    await prisma.bodega.upsert({
      where: { clienteId_nombre: { clienteId: cliente.id, nombre } },
      update: {},
      create: { clienteId: cliente.id, nombre, activo: true },
    });
  }

  // Materiales semilla
  for (const m of MATERIALES_SEMILLA) {
    await prisma.itemCatalogo.upsert({
      where: { id: BigInt(MATERIALES_SEMILLA.indexOf(m) + 1) },
      update: {},
      create: { ...m, estado: 'aprobado', activo: true },
    });
  }

  console.log('\n========================================');
  console.log('Seed completo');
  console.log('========================================');
  console.log(`Cliente: ${cliente.nombre}`);
  console.log(`Bodegas: ${BODEGAS.length}`);
  console.log(`Materiales semilla: ${MATERIALES_SEMILLA.length}`);
  console.log('\nUsuarios:');
  for (const r of userResults) {
    if (r.created) {
      console.log(`  ${r.user.username.padEnd(10)} (${r.user.role.padEnd(11)}) password: ${r.password}`);
    } else {
      console.log(`  ${r.user.username.padEnd(10)} (${r.user.role.padEnd(11)}) [existed, password not changed]`);
    }
  }
  console.log('========================================');
  console.log('Guardá las contraseñas YA. No se vuelven a mostrar.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
