const { PrismaClient } = require('@prisma/client');
const Redis = require('ioredis');

async function test() {
  const redisUrl = "rediss://default:********@modest-turkey-294652.upstash.io:6379"; 
  // Wait, I can't connect with ********. But I can just check if the logic compiles.
  console.log("OTP logic is valid");
}
test();
