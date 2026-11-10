/*
 * FLOOD  -  global port of the flood processors from the map "flood 55"
 *           ("flood base ATK v1.24" by Makise).
 *
 * The map has 58 world processors; 30 of them (3 groups of 10, in the bottom-left corner
 * of the map) are the actual spreading logic.  They form THREE TIERS that feed into each
 * other (all on one team in the map: team 2, crux = red):
 *
 *   tier 3  scrap wall          x10 procs  dmg 350  cap 10000  speed divisor 15
 *             empty tile        -> titanium conveyor (random rotation)
 *             own-team building -> scrap wall
 *   tier 2  titanium conveyor   x2  procs  divisor 15  +  x8 procs divisor 3   dmg 100  cap 6000
 *             empty tile        -> conveyor (random rotation)
 *             own-team building -> titanium conveyor           (scrap walls are left alone)
 *   tier 1  conveyor            x10 procs  dmg 50   cap 10000  speed divisor 15
 *             empty tile        -> conveyor (random rotation)
 *             own-team building -> conveyor      (scrap walls AND titanium conveyors are left alone)
 *
 * Every loop of a processor:
 *   1. count = how many blocks of its tier the flood team owns
 *   2. pick one of them at random, and set the processor speed ("setrate") to
 *      random(count) / divisor instructions per tick  -> a bigger flood spreads faster
 *   3. look at its 4 neighbours in the order  east, west, north, south:
 *        - nothing there, plain floor (air)       -> grow into it
 *        - enemy-team building                    -> explosion (radius 3 tiles, tier damage)
 *        - own-team building, below the cap       -> overwrite it with the tier's block
 *        - solid static block / map edge          -> nothing
 *
 * To keep the pace identical, each virtual processor is given an instruction
 * budget (ipt per tick) and every loop "costs" exactly as many instructions as the
 * original mlog path did (tables below were measured from the extracted code).
 *
 * ADDED ON TOP OF THE MAP LOGIC (v1.2):
 *   - TWO floods: red (crux) and blue.  Each runs the full three-tier logic by itself.  Pick which
 *     ones spread in Settings -> Flood, or with  /flood team red|blue|both.
 *     Red blocks and blue blocks are enemies and blast each other like any other enemy building.
 *   - CORE RULES.  A flood never overwrites its own core.  Flood blasts are skipped when they would
 *     reach the yellow (player) core, and also a red/blue core unless "core war" is switched on.
 *   - New players start on the yellow team (the "sharded" team). After that, their own team choice is respected.
 *   - Green and purple floods exist too (off by default), each with its own seed block.
 *   - The vanilla FORCE PROJECTOR is the shield (no new shield block).  While it is working (powered, not
 *     broken) it holds the flood back:  conveyor and titanium-conveyor flood cannot enter it at all, scrap-wall
 *     flood creeps in slowly, thorium-wall flood a bit faster.  Flood blocks pressing on the shield wear it down
 *     and exploding crawlers next to it break it fast; once it is broken (or has no power) the flood finds the
 *     opening and pours in.
 *   - A fourth, stronger and slower flood tier: THORIUM WALL (not in the map).  Scrap walls upgrade to thorium
 *     walls slowly by themselves; thorium walls blast for 700, push through shields and are not overwritten by
 *     the other tiers.
 *   - Flying units AND ground machines take damage near flood blocks of another team (flyers: when over one,
 *     ground units: on or right next to one).  The player's own unit too, unless switched off.
 *   - A crawler of a flood team plants new flood where it blows up.
 *   - Buildable "Flood Seed" blocks (Effects menu), red / blue / green / purple, in a normal (scrap wall) and a
 *     thorium version: built, they turn into flood of that team.
 *   - Nothing spreads while the game is paused.
 *
 * NOT ported (they are other jobs of the same map, not the spreading): the units that spawn from
 * flood tiles, the boss patrol AI, the "anti flood bomb" player weapon, the flood stats display, and
 * four floor-pattern spreaders that only make sense on that one map's custom floor.
 *
 * Only the host / server runs it; tile changes are synced to clients with tile.setNet.
 *
 * Chat commands (admin, or singleplayer):
 *   /flood stats | seed [n] [team] | team red|blue|green|purple|both|all | corewar on|off | on | off
 * Settings: Settings -> Flood   (client builds only; servers use the commands)
 */

var floodMod = (function(){

    // ---------------------------------------------------------------- configuration
    var CFG = {
        redId: 2,           // crux  - `set team 2` in every flood processor of the map
        blueId: 5,          // Team.blue
        yellowId: 1,        // Team.sharded = the player team (yellow)
        greenId: 4,         // Team.green
        purpleId: 3,        // Team.malis (purple)
        shieldRefresh: 20,  // ticks between looks at which Force Projectors are standing
        // How a working Force Projector treats each flood tier (tier 1 conveyor, 2 titanium, 3 scrap, 4 thorium):
        shieldPass: { 1: 0, 2: 0, 3: 0.03, 4: 0.12 },        // chance that one attempt to grow INTO the shield gets through
        shieldPressure: { 1: 0.5, 2: 1.5, 3: 6, 4: 20 },     // shield "buildup" added by every attempt (a projector sheds ~105 per second)
        crawlerShieldHit: 0.35,    // an exploding crawler adds this fraction of the shield's health as buildup
        crawlerShieldReach: 3,     // tiles outside the shield edge that still count as "right next to it"
        evolveEvery: 300,   // ticks between "scrap wall -> thorium wall" upgrades (one per flood)
        evolveMinScrap: 100,// a flood needs this many scrap walls before it starts growing thorium walls
        evolveRatio: 0.05,  // ... and keeps about this share of its scrap walls as thorium
        thoriumShare: 0.12, // tier 4 stops upgrading scrap walls once thorium walls are this share of them (they stay a strong minority)
        blastRadius: 3,     // `set raid 3`  (tiles)
        maxIpt: 500,        // upper clamp of `setrate` (my assumption for world processors - not confirmed from source). Lower it if the game lags
        maxLoopsPerTick: 64,// safety valve per virtual processor per tick
        coreMargin: 1.5,    // blasts are skipped within (blast radius + core half size + this) tiles of a protected core
        airInterval: 10,    // ticks between "flyer over flood" checks
        airDmg: { conveyor: 3, titanium: 6, scrap: 12, thorium: 24 },    // flyers over a flood block: damage per check (x6 per second)
        groundDmg: { conveyor: 2, titanium: 4, scrap: 8, thorium: 16 }, // ground machines on / next to one
        infectSeeds: 2,     // flood seeds a dying crawler plants
        infectRadius: 2,
        yellowCheck: 60     // ticks between "everybody is yellow" checks
    };

    var TILE = 8;                 // world units per tile (Vars.tilesize)
    var DX = [1, -1, 0, 0];       // east, west, north, south  (same order as the processors)
    var DY = [0, 0, 1, -1];

    // Instruction cost of one processor loop (measured from the original mlog, see header).
    var COST_FAIL = 7;            // nothing fetched -> loop restarts after 7 instructions
    var COST_HEAD = 9;            // fetch / rand / div / setrate / fetch / jump / sensor x2 / print
    var COST_TAIL = 2;
    // A stage fires once this many instructions of its cost have been paid (its effect sits near the end
    // of the stage in the real processor): head, east, west, north, south, tail.
    var NEED = [5, 11, 11, 11, 11, 1];
    // Cost of one neighbour, indexed by direction [E, W, N, S] (includes the print that precedes it).
    var COST = {
        1: { protScrap: [8, 8, 10, 8], protTi: [9, 9, 9, 9], replace: [14, 14, 15, 14], cap: [13, 13, 14, 13],
             explode: [13, 13, 14, 13], place: [13, 13, 14, 13], blocked: [11, 11, 12, 11] },
        2: { protScrap: [8, 8, 9, 8], replace: [13, 13, 14, 13], cap: [12, 12, 13, 12],
             explode: [12, 12, 13, 12], place: [12, 12, 13, 12], blocked: [10, 10, 11, 10] },
        3: { replace: [12, 13, 13, 12], cap: [11, 12, 12, 11],
             explode: [11, 12, 12, 11], place: [11, 11, 12, 11], blocked: [8, 8, 9, 8] },
        // tier 4 (thorium wall) is not in the map: it simply costs the same as tier 3
        4: { replace: [12, 13, 13, 12], cap: [11, 12, 12, 11],
             explode: [11, 12, 12, 11], place: [11, 11, 12, 11], blocked: [8, 8, 9, 8] }
    };

    // ---------------------------------------------------------------- state
    var B = null;          // vanilla blocks (resolved lazily, they are not safe to touch at script load)
    var CORE_CLASS = null; // mindustry CoreBlock class, used to recognise cores
    var floods = null;     // [red, blue, green, purple] flood contexts
    var shieldBlocks = []; // vanilla Force Projector blocks (Force Projector + the Erekir shield projectors)
    var shields = [];      // working shields seen at the last refresh: {b, x, y, r, r2, team} (tile units)
    var shieldPushOff = false; // set if writing the shield's buildup ever fails (shields then only block, never wear)
    var seedNames = {};    // name of a Flood Seed block -> [flood index, "scrap" | "thorium"]
    var seenPlayers = [];  // players already placed on yellow once
    var yellow = null;     // Team.sharded
    var ticks = 0;
    var seeded = false;
    var registered = false;
    var sysErrors = { spread: 0, air: 0, yellow: 0, shield: 0, evolve: 0 };
    var rng = function(){ return Math.random(); };

    // ---------------------------------------------------------------- settings helpers
    function getBool(name, def){ return Core.settings.getBool(name, def); }
    function getInt(name, def){ return Core.settings.getInt(name, def); }

    function makeFlood(id, key, name, on){
        var fl = { id: id, key: key, name: name, on: on, team: Team.get(id), tiers: null, procs: [] };
        // [divisor of each virtual processor] copied from the map: 10 / (2 + 8) / 10 processors
        var rep = function(v, n){ var a = []; for(var i = 0; i < n; i++) a.push(v); return a; };
        fl.tiers = [
            { id: 1, name: "conveyor",         block: B.conveyor,         dmg: 50,  max: 10000, divs: rep(15, 10), fl: fl },
            { id: 2, name: "titanium-conveyor", block: B.titaniumConveyor, dmg: 100, max: 6000,  divs: [15, 15].concat(rep(3, 8)), fl: fl },
            { id: 3, name: "scrap-wall",        block: B.scrapWall,        dmg: 350, max: 10000, divs: rep(15, 10), fl: fl },
            // tier 4 is NOT in the map: strong and slow
            { id: 4, name: "thorium-wall",      block: B.thoriumWall,      dmg: 700, max: 2500,  divs: rep(60, 4),  fl: fl }
        ];
        for(var i = 0; i < fl.tiers.length; i++){
            for(var j = 0; j < fl.tiers[i].divs.length; j++){
                fl.procs.push({ tier: fl.tiers[i], div: fl.tiers[i].divs[j], ipt: 8, budget: 0, stage: 0, x: 0, y: 0, count: 0 });
            }
        }
        return fl;
    }

    function init(){
        B = {
            air: Blocks.air, conveyor: Blocks.conveyor, titaniumConveyor: Blocks.titaniumConveyor,
            scrapWall: Blocks.scrapWall, thoriumWall: Blocks.thoriumWall
        };
        try{
            CORE_CLASS = (typeof CoreBlock !== "undefined") ? CoreBlock : Packages.mindustry.world.blocks.storage.CoreBlock;
        }catch(e){
            CORE_CLASS = null;
            Log.err("[flood] could not find the CoreBlock class, cores cannot be recognised: " + e);
        }
        yellow = Team.get(CFG.yellowId);
        floods = [ makeFlood(CFG.redId, "flood-red", "red", true), makeFlood(CFG.blueId, "flood-blue", "blue", true),
                   makeFlood(CFG.greenId, "flood-green", "green", false), makeFlood(CFG.purpleId, "flood-purple", "purple", false) ];
        shieldBlocks = [];
        var wanted = ["forceProjector", "shieldProjector", "largeShieldProjector"];   // Force Projector (+ the Erekir shield projectors)
        for(var q = 0; q < wanted.length; q++){
            try{ if(Blocks[wanted[q]] != null) shieldBlocks.push(Blocks[wanted[q]]); }catch(e3){}
        }
        seedNames = {};
        var teamNames = ["red", "blue", "green", "purple"];
        for(var n = 0; n < teamNames.length; n++){
            seedNames["flood-mod-flood-seed-" + teamNames[n]] = [n, "scrap"];
            seedNames["flood-mod-flood-seed-" + teamNames[n] + "-thorium"] = [n, "thorium"];
        }
    }

    function floodActive(fl){ return getBool(fl.key, fl.on); }

    function floodOfTeamId(id){
        for(var i = 0; i < floods.length; i++) if(floods[i].id == id) return floods[i];
        return null;
    }

    // ---------------------------------------------------------------- world helpers
    function buildingsOf(fl, block){
        return Vars.state.teams.get(fl.team).getBuildings(block);
    }

    function isCore(b){
        if(CORE_CLASS == null) return false;
        return b.block instanceof CORE_CLASS;
    }

    function coresOf(team){
        try{ var c = Vars.state.teams.cores(team); if(c != null) return c; }catch(e){}
        try{ return Vars.state.teams.get(team).cores; }catch(e2){}
        return null;
    }

    // ---- Force Projector = the shield.  While one is working (valid, powered so its radius is > 0, not broken)
    // it holds the flood back: see shieldGate().  Its own team's flood is not held by it.
    function shieldRadius(b){
        try{ return b.realRadius(); }catch(e){
            try{ return b.efficiency > 0 ? b.block.radius : 0; }catch(e2){ return 0; }
        }
    }

    function refreshShields(){
        var out = [];
        if(getBool("flood-shield", true)){
            for(var k = 0; k < shieldBlocks.length; k++){
                for(var id = 0; id < 10; id++){
                    var seq = Vars.state.teams.get(Team.get(id)).getBuildings(shieldBlocks[k]);
                    if(seq == null) continue;
                    for(var i = 0; i < seq.size; i++){
                        var b = seq.get(i);
                        if(b == null || !b.isValid() || b.broken) continue;
                        var r = shieldRadius(b) / TILE;
                        if(!(r > 1)) continue;                       // no power / switched off: no shield, nothing held back
                        out.push({ b: b, x: b.x / TILE, y: b.y / TILE, r: r, r2: r * r, team: b.team.id });
                    }
                }
            }
        }
        shields = out;
    }

    // The working shield that covers tile (x, y) and holds the flood `fl` back, or null.
    function shieldAt(fl, x, y){
        for(var i = 0; i < shields.length; i++){
            var s = shields[i];
            if(s.team == fl.id) continue;                            // a team's own shield does not hold its own flood
            var dx = x - s.x, dy = y - s.y;
            if(dx * dx + dy * dy > s.r2) continue;
            if(s.b.broken || !s.b.isValid()) continue;               // broken since the last refresh: the flood is through
            return s;
        }
        return null;
    }

    // Adds "buildup" (the damage meter of a Force Projector).  At its limit the projector breaks by itself.
    function pushShield(s, amount){
        if(amount <= 0 || shieldPushOff) return;
        try{
            s.b.buildup += amount;
        }catch(e){
            shieldPushOff = true;
            Log.err("[flood] could not write the Force Projector buildup, shields will only block: " + e);
        }
    }

    // One flood attempt to grow into tile (nx, ny).  true = the shield stopped it.  Every attempt presses on the
    // shield; only the strong tiers sometimes get through.
    function shieldGate(tier, fl, nx, ny){
        var s = shieldAt(fl, nx, ny);
        if(s == null) return false;
        pushShield(s, CFG.shieldPressure[tier.id]);
        return rng() >= CFG.shieldPass[tier.id];
    }

    // A crawler blew up: every working shield of another team that it was right next to takes a big hit.
    function crawlerHitsShields(u){
        var ux = u.x / TILE, uy = u.y / TILE;
        for(var i = 0; i < shields.length; i++){
            var s = shields[i];
            if(s.team == u.team.id || s.b.broken || !s.b.isValid()) continue;
            var reach = s.r + CFG.crawlerShieldReach;
            var dx = ux - s.x, dy = uy - s.y;
            if(dx * dx + dy * dy > reach * reach) continue;
            pushShield(s, s.b.block.shieldHealth * CFG.crawlerShieldHit);
        }
    }

    // Would a blast centred on tile (nx, ny) reach a core that this flood must not hurt?
    // Protected: yellow cores always; the other flood's cores unless "core war" is on.
    // (Its own team is never hurt by its own blasts, so its own cores need no check.)
    function nearProtectedCore(fl, nx, ny){
        var cross = getBool("flood-corewar", false);
        var ids = [CFG.yellowId];
        for(var i = 0; i < floods.length; i++){
            if(floods[i].id != fl.id && !cross) ids.push(floods[i].id);
        }
        for(var k = 0; k < ids.length; k++){
            var cores = coresOf(Team.get(ids[k]));
            if(cores == null) continue;
            for(var j = 0; j < cores.size; j++){
                var c = cores.get(j);
                var reach = CFG.blastRadius + c.block.size / 2 + CFG.coreMargin;
                var dx = nx - c.tile.x, dy = ny - c.tile.y;
                if(dx * dx + dy * dy <= reach * reach) return true;
            }
        }
        return false;
    }

    function put(fl, t, block, roll){
        var rot = Math.floor(roll);
        if(rot < 0) rot = 0; else if(rot > 3) rot = 3;
        if(getBool("flood-cheap", false)){
            // optional lag saver: re-placing the identical block is only a heal + new rotation
            var b = t.build;
            if(b != null && b.block === block && b.team.id == fl.id){ b.heal(); return; }
        }
        t.setNet(block, fl.team, rot);
    }

    // `explosion team x y raid dmg true true false`  (skipped when it would reach a protected core)
    function blast(fl, x, y, dmg){
        if(nearProtectedCore(fl, x, y)) return;
        Damage.damage(fl.team, x * TILE, y * TILE, CFG.blastRadius * TILE, dmg, false, true, true);
    }

    // ---------------------------------------------------------------- the three tiers
    // Each visit() = one neighbour of one loop. Returns the instruction cost of that path.
    // The random roll is drawn exactly where the processors draw it (matters for the tests only).

    function visit1(tier, nx, ny, d, count){            // conveyor flood
        var c = COST[1], fl = tier.fl;
        var t = Vars.world.tile(nx, ny);
        var roll = rng() * 4;
        if(shields.length > 0 && shieldGate(tier, fl, nx, ny)) return c.blocked[d];   // held back by a Force Projector
        var b = t == null ? null : t.build;
        if(b != null){
            var bb = b.block;
            if(bb === B.scrapWall) return c.protScrap[d];
            if(bb === B.titaniumConveyor) return c.protTi[d];
            if(bb === B.thoriumWall && b.team.id == fl.id) return c.protScrap[d];   // own thorium walls are left alone
            if(b.team.id != fl.id){ blast(fl, nx, ny, tier.dmg); return c.explode[d]; }
            if(count >= tier.max || isCore(b)) return c.cap[d];       // never overwrite the team's own core
            put(fl, t, B.conveyor, roll);
            return c.replace[d];
        }
        if(t != null && t.block() === B.air){ put(fl, t, B.conveyor, roll); return c.place[d]; }
        return c.blocked[d];
    }

    function visit2(tier, nx, ny, d, count){            // titanium conveyor flood
        var c = COST[2], fl = tier.fl;
        var t = Vars.world.tile(nx, ny);
        var roll = rng() * 4;
        if(shields.length > 0 && shieldGate(tier, fl, nx, ny)) return c.blocked[d];
        var b = t == null ? null : t.build;
        if(b != null){
            if(b.block === B.scrapWall) return c.protScrap[d];
            if(b.block === B.thoriumWall && b.team.id == fl.id) return c.protScrap[d];
            if(b.team.id != fl.id){ blast(fl, nx, ny, tier.dmg); return c.explode[d]; }
            if(count >= tier.max || isCore(b)) return c.cap[d];
            put(fl, t, B.titaniumConveyor, roll);
            return c.replace[d];
        }
        if(t != null && t.block() === B.air){ put(fl, t, B.conveyor, roll); return c.place[d]; }
        return c.blocked[d];
    }

    function visit3(tier, nx, ny, d, count){            // scrap wall flood
        var c = COST[3], fl = tier.fl;
        var t = Vars.world.tile(nx, ny);
        if(shields.length > 0 && shieldGate(tier, fl, nx, ny)) return c.blocked[d];
        var b = t == null ? null : t.build;
        if(b != null){
            if(b.team.id != fl.id){ blast(fl, nx, ny, tier.dmg); return c.explode[d]; }
            if(b.block === B.thoriumWall) return c.cap[d];            // own thorium walls are left alone
            if(count >= tier.max || isCore(b)) return c.cap[d];
            put(fl, t, B.scrapWall, 0);
            return c.replace[d];
        }
        if(t != null && t.block() === B.air){ put(fl, t, B.titaniumConveyor, rng() * 4); return c.place[d]; }
        return c.blocked[d];
    }

    function visit4(tier, nx, ny, d, count){            // thorium wall flood: strong and slow (NOT in the map)
        var c = COST[4], fl = tier.fl;
        var t = Vars.world.tile(nx, ny);
        if(shields.length > 0 && shieldGate(tier, fl, nx, ny)) return c.blocked[d];
        var b = t == null ? null : t.build;
        if(b != null){
            if(b.team.id != fl.id){ blast(fl, nx, ny, tier.dmg); return c.explode[d]; }
            if(count >= tier.max || isCore(b) || b.block !== B.scrapWall) return c.cap[d];   // it only upgrades scrap walls
            if(count >= Math.floor(buildingsOf(fl, B.scrapWall).size * CFG.thoriumShare)) return c.cap[d];   // ... and only up to a share of them
            put(fl, t, B.thoriumWall, 0);
            return c.replace[d];
        }
        if(t != null && t.block() === B.air){ put(fl, t, B.scrapWall, 0); return c.place[d]; }   // pioneers are scrap walls
        return c.blocked[d];
    }

    var VISIT = { 1: visit1, 2: visit2, 3: visit3, 4: visit4 };

    // One STAGE of one processor loop: stage 0 = head (count / setrate / fetch), stages 1-4 = the four
    // neighbours (E, W, N, S), stage 5 = tail.  Returns the instructions that stage used.  The scheduler
    // pays for stages one by one, so effects land spread out over a loop like they do in the processor.
    function advance(proc){
        var tier = proc.tier;
        var st = proc.stage;
        if(st == 0){
            var seq = buildingsOf(tier.fl, tier.block);
            var count = seq == null ? 0 : seq.size;
            var idr = rng() * count;                                   // op rand idr count
            var ipt = Math.floor(idr / proc.div);                      // op div idr2 idr <divisor>
            proc.ipt = Math.max(1, Math.min(CFG.maxIpt, ipt));         // setrate idr2
            var idx = Math.floor(idr);
            var fet = (idx < count) ? seq.get(idx) : null;             // fetch build fet team idr <block>
            if(fet == null) return COST_FAIL;                          // loop restarts
            proc.x = fet.tile.x; proc.y = fet.tile.y; proc.count = count;
            proc.stage = 1;
            return COST_HEAD;
        }
        if(st <= 4){
            var d = st - 1;
            proc.stage = st + 1;
            return VISIT[tier.id](tier, proc.x + DX[d], proc.y + DY[d], d, proc.count);
        }
        proc.stage = 0;
        return COST_TAIL;
    }

    // One full loop at once (what the tests compare against the original processor code).
    function iterate(tier, proc){
        proc.stage = 0;
        var cost = advance(proc);
        if(proc.stage == 0) return cost;
        for(var d = 0; d < 5; d++) cost += advance(proc);
        return cost;
    }

    // ---------------------------------------------------------------- seeding / infection
    function floodBlockCount(fl){
        return buildingsOf(fl, B.conveyor).size + buildingsOf(fl, B.titaniumConveyor).size + buildingsOf(fl, B.scrapWall).size;
    }

    function freeTile(t){
        return t != null && t.build == null && t.block() === B.air && !t.solid() && !t.floor().isDeep();
    }

    // Plants flood seeds (a scrap wall of the team grows into all three tiers by itself).
    function plantSeeds(n, fl){
        var w = Vars.world.width(), h = Vars.world.height();
        var minDist = 25; // tiles away from any enemy core
        var done = 0, tries = 0;
        while(done < n && tries < 500 * n){
            tries++;
            var x = Math.floor(rng() * w), y = Math.floor(rng() * h);
            var t = Vars.world.tile(x, y);
            if(!freeTile(t) || shieldAt(fl, x, y) != null) continue;
            if(t.overlay() === Blocks.spawn) continue;
            var core = null;
            try{ core = Vars.state.teams.closestEnemyCore(x * TILE, y * TILE, fl.team); }catch(e){}
            if(core != null && Mathf.dst(core.x, core.y, x * TILE, y * TILE) < minDist * TILE) continue;
            t.setNet(B.scrapWall, fl.team, 0);
            done++;
        }
        return done;
    }

    // A crawler of a flood team died: plant new flood on free tiles around the spot.
    function infectAt(fl, tx, ty){
        var planted = 0, tries = 0, r = CFG.infectRadius;
        while(planted < CFG.infectSeeds && tries++ < 20){
            var x = tx + Math.floor(rng() * (2 * r + 1)) - r;
            var y = ty + Math.floor(rng() * (2 * r + 1)) - r;
            var t = Vars.world.tile(x, y);
            if(!freeTile(t) || shieldAt(fl, x, y) != null) continue;
            t.setNet(B.scrapWall, fl.team, 0);
            planted++;
        }
        return planted;
    }

    // ---------------------------------------------------------------- anti-air, yellow team
    function hurt(u, amount){
        if(typeof u.damagePierce === "function") u.damagePierce(amount); else u.damage(amount);
    }

    // Damage per check from the flood block on tile t, for a unit of team teamId (0 = none: nothing there, own team, flood off).
    function floodDmg(t, teamId, table){
        if(t == null) return 0;
        var b = t.build;
        if(b == null) return 0;
        var fl = floodOfTeamId(b.team.id);
        if(fl == null || !floodActive(fl) || teamId == b.team.id) return 0;
        var blk = b.block;
        if(blk === B.thoriumWall) return table.thorium;
        if(blk === B.scrapWall) return table.scrap;
        if(blk === B.titaniumConveyor) return table.titanium;
        if(blk === B.conveyor) return table.conveyor;
        return 0;
    }

    // Flying units hovering over the flood of ANOTHER team take damage; ground machines take damage when they stand
    // on a flood block or right next to one (the 4 tiles around).  The player's own unit too, unless switched off.
    function antiAir(){
        var g = Groups.unit;
        var ground = getBool("flood-ground", true);
        for(var i = g.size() - 1; i >= 0; i--){
            if(i >= g.size()) continue;
            var u = g.index(i);
            if(u == null || u.dead) continue;
            var flying = u.isFlying();
            if(!flying && !ground) continue;
            if(u.isPlayer() && !getBool("flood-airplayer", true)) continue;   // the player's own unit is hurt too, unless switched off
            var t = u.tileOn();
            if(t == null) continue;
            var tid = u.team.id, dmg = 0;
            if(flying){
                dmg = floodDmg(t, tid, CFG.airDmg);
            }else{
                dmg = floodDmg(t, tid, CFG.groundDmg);
                for(var k = 0; k < 4; k++){
                    var near = floodDmg(Vars.world.tile(t.x + DX[k], t.y + DY[k]), tid, CFG.groundDmg);
                    if(near > dmg) dmg = near;
                }
            }
            if(dmg > 0) hurt(u, dmg);
        }
    }

    // Strong flood: a flood with enough scrap walls slowly turns some of them into thorium walls (tier 4).
    function evolve(){
        if(!getBool("flood-strong", true)) return;
        for(var f = 0; f < floods.length; f++){
            var fl = floods[f];
            if(!floodActive(fl)) continue;
            var scrap = buildingsOf(fl, B.scrapWall), thor = buildingsOf(fl, B.thoriumWall);
            if(scrap.size < CFG.evolveMinScrap || thor.size >= Math.floor(scrap.size * CFG.evolveRatio) || thor.size >= fl.tiers[3].max) continue;
            var b = scrap.get(Math.floor(rng() * scrap.size));
            if(b == null || isCore(b) || shieldAt(fl, b.tile.x, b.tile.y) != null) continue;
            b.tile.setNet(B.thoriumWall, fl.team, 0);
        }
    }

    // Players START on yellow (sharded).  Each player is put there once; after that their own team
    // choice (for example switching to blue to build things) is never touched again.
    function enforceYellow(){
        if(!getBool("flood-yellow", true)) return;
        try{ Vars.state.rules.defaultTeam = yellow; }catch(e){}
        var g = Groups.player;
        var stillHere = [];
        for(var i = 0; i < g.size(); i++){
            var p = g.index(i);
            if(p == null) continue;
            if(seenPlayers.indexOf(p) < 0){
                if(p.team().id != CFG.yellowId) p.team(yellow);
            }
            stillHere.push(p);
        }
        seenPlayers = stillHere;
    }

    // ---------------------------------------------------------------- main loop
    function floodsEnabled(){
        if(!getBool("flood-enabled", true)) return false;
        if(Vars.state.isCampaign() && !getBool("flood-campaign", false)) return false;
        return true;
    }

    function sys(name, fn){
        if(sysErrors[name] >= 5) return;
        try{
            fn();
        }catch(e){
            sysErrors[name]++;
            Log.err("[flood] " + name + " error (" + sysErrors[name] + "/5): " + e);
            if(sysErrors[name] >= 5) Log.err("[flood] " + name + " disabled for this session after repeated errors");
        }
    }

    function seedAll(){
        var n = getInt("flood-seeds", 3);
        for(var i = 0; i < floods.length; i++){
            if(floodActive(floods[i]) && floodBlockCount(floods[i]) == 0) plantSeeds(n, floods[i]);
        }
    }

    function spread(){
        if(!seeded && ticks >= getInt("flood-delay", 60) * 60){
            seeded = true;
            if(getBool("flood-autoseed", true)) seedAll();
        }
        var speed = getInt("flood-speed", 100) / 100;
        for(var f = 0; f < floods.length; f++){
            if(!floodActive(floods[f])) continue;
            var procs = floods[f].procs;
            for(var i = 0; i < procs.length; i++){
                var p = procs[i];
                p.budget += p.ipt * speed;
                var guard = 0;
                while(p.budget >= NEED[p.stage] && guard++ < CFG.maxLoopsPerTick){
                    p.budget -= advance(p);
                }
            }
        }
    }

    function update(){
        if(Vars.net.client() || Vars.state.isEditor() || !Vars.state.isGame()) return;
        if(Vars.state.isPaused()) return;                      // frozen while the game is paused
        if(floods == null) init();
        ticks++;
        if(!Vars.state.isCampaign() && ticks % CFG.yellowCheck == 1) sys("yellow", enforceYellow);
        if(!floodsEnabled()) return;
        if(ticks % CFG.shieldRefresh == 1) sys("shield", refreshShields);
        sys("spread", spread);
        if(ticks % CFG.evolveEvery == 0) sys("evolve", evolve);
        if(ticks % CFG.airInterval == 0 && getBool("flood-antiair", true)) sys("air", antiAir);
    }

    function reset(){
        floods = null; ticks = 0; seeded = false;
        shields = []; seenPlayers = [];
        sysErrors.yellow = 0; sysErrors.shield = 0;
    }

    function safeUpdate(){
        try{
            update();
        }catch(e){
            sysErrors.spread++;
            if(sysErrors.spread <= 5) Log.err("[flood] update error: " + e);
        }
    }

    // ---------------------------------------------------------------- event handlers
    function onUnitDestroy(e){
        if(Vars.net.client()) return;
        var u = e.unit;
        if(u == null || u.type !== UnitTypes.crawler) return;
        if(floods == null) init();
        if(!floodsEnabled() || Vars.state.isPaused()) return;
        if(getBool("flood-shield", true)){
            try{ crawlerHitsShields(u); }catch(err){ Log.err("[flood] crawler/shield check failed: " + err); }   // a blast next to a Force Projector wears it down
        }
        if(!getBool("flood-infect", true)) return;
        var fl = floodOfTeamId(u.team.id);
        if(fl == null || !floodActive(fl)) return;
        infectAt(fl, Math.round(u.x / TILE), Math.round(u.y / TILE));
    }

    // A "Flood Seed" finished building -> it becomes flood of that team: a scrap wall (the normal seed) or a
    // thorium wall (the thorium seed).
    function onBuildEnd(e){
        if(Vars.net.client() || e.breaking) return;
        var t = e.tile;
        if(t == null) return;
        if(floods == null) init();
        var name = String(t.block().name);
        if(!Object.prototype.hasOwnProperty.call(seedNames, name)) return;
        var seed = seedNames[name];
        var fl = floods[seed[0]];
        Core.settings.put(fl.key, true);                       // placing a seed switches that flood on
        t.setNet(seed[1] == "thorium" ? B.thoriumWall : B.scrapWall, fl.team, 0);
    }

    function onPlayerJoin(e){
        if(Vars.net.client() || Vars.state.isCampaign()) return;
        if(floods == null) init();
        enforceYellow();
    }

    // ---------------------------------------------------------------- commands + settings
    function teamArg(a){
        if(floods == null) init();
        if(a == "red") return [floods[0]];
        if(a == "blue") return [floods[1]];
        if(a == "green") return [floods[2]];
        if(a == "purple") return [floods[3]];
        if(a == "both") return [floods[0], floods[1]];
        if(a == "all") return floods;
        return null;
    }

    function stats(){
        if(floods == null) init();
        var parts = [];
        var tags = ["[scarlet]Red", "[royal]Blue", "[green]Green", "[purple]Purple"];
        for(var i = 0; i < floods.length; i++){
            var fl = floods[i];
            var c1 = buildingsOf(fl, B.conveyor).size, c2 = buildingsOf(fl, B.titaniumConveyor).size;
            var c3 = buildingsOf(fl, B.scrapWall).size, c4 = buildingsOf(fl, B.thoriumWall).size;
            if(!floodActive(fl) && c1 + c2 + c3 + c4 == 0) continue;   // hide idle teams
            parts.push(tags[i] + (floodActive(fl) ? "" : " (off)") + "[]: conveyors " + c1 + ", titanium " + c2 +
                ", scrap " + c3 + (c4 > 0 ? ", thorium " + c4 : ""));
        }
        refreshShields();
        return "[sky]Flood:[] " + parts.join("  |  ") + "  |  working shields: " + shields.length;
    }

    // Everything the game calls into is wrapped, so a bug here logs an error instead of crashing the game.
    function guarded(label, fn){
        return function(a, b){
            try{ return fn(a, b); }catch(e){ Log.err("[flood] " + label + " failed: " + e); }
        };
    }

    function registerCommands(){
        if(registered) return;
        var handler = Vars.netServer == null ? null : Vars.netServer.clientCommands;
        if(handler == null) return;
        var run = guarded("/flood", function(args, player){
            var action = args.length > 0 ? String(args[0]) : "stats";
            var allowed = !Vars.net.active() || player.admin;
            if(floods == null) init();
            if(action == "stats"){
                player.sendMessage(stats());
            }else if(!allowed){
                player.sendMessage("[scarlet]Only admins can do that.");
            }else if(action == "on" || action == "off"){
                Core.settings.put("flood-enabled", action == "on");
                player.sendMessage("[sky]Flood:[] " + action);
            }else if(action == "corewar"){
                var warOn = args.length > 1 && String(args[1]) == "on";
                Core.settings.put("flood-corewar", warOn);
                player.sendMessage("[sky]Flood:[] core war " + (warOn ? "on (red/blue floods may hurt each other's cores)" : "off (no flood can hurt any core)"));
            }else if(action == "team"){
                var sel = args.length > 1 ? String(args[1]) : "";
                if(teamArg(sel) == null){
                    player.sendMessage("[sky]Usage:[] /flood team red|blue|green|purple|both|all");
                }else{
                    var chosen = teamArg(sel);
                    for(var q = 0; q < floods.length; q++) Core.settings.put(floods[q].key, chosen.indexOf(floods[q]) >= 0);
                    player.sendMessage("[sky]Flood:[] spreading team(s): " + sel);
                }
            }else if(action == "seed"){
                var n = args.length > 1 ? parseInt(args[1]) : getInt("flood-seeds", 3);
                if(isNaN(n) || n < 1) n = 1;
                var which = args.length > 2 ? teamArg(String(args[2])) : null;
                if(which == null){
                    which = [];
                    for(var i = 0; i < floods.length; i++) if(floodActive(floods[i])) which.push(floods[i]);
                }else{
                    for(var k = 0; k < which.length; k++) Core.settings.put(which[k].key, true);
                }
                var msg = [];
                for(var j = 0; j < which.length; j++) msg.push(which[j].name + " " + plantSeeds(Math.min(n, 50), which[j]));
                player.sendMessage("[sky]Flood:[] planted seeds - " + msg.join(", "));
            }else{
                player.sendMessage("[sky]Usage:[] /flood stats | seed [n] [team] | team red|blue|green|purple|both|all | corewar on|off | on | off");
            }
        });
        // A bare JS function is ambiguous here (register(..., Cons) vs register(..., CommandRunner)),
        // so the runner object is built explicitly.
        var CH = (typeof CommandHandler !== "undefined") ? CommandHandler : Packages.arc.util.CommandHandler;
        var runner;
        try{
            runner = new CH.CommandRunner({ accept: run });
        }catch(e){
            runner = new JavaAdapter(CH.CommandRunner, { accept: run });
        }
        handler.register("flood", "[action] [a] [b]", "Flood mod: stats | seed [n] [team] | team red|blue|green|purple|both|all | corewar on|off | on | off", runner);
        registered = true;
    }

    function buildSettings(){
        try{
            var props = Core.bundle.getProperties();
            props.put("setting.flood-enabled.name", "Flood enabled");
            props.put("setting.flood-red.name", "Red flood spreads");
            props.put("setting.flood-blue.name", "Blue flood spreads");
            props.put("setting.flood-corewar.name", "Core war (red/blue floods may hurt each other's cores)");
            props.put("setting.flood-green.name", "Green flood spreads");
            props.put("setting.flood-purple.name", "Purple flood spreads");
            props.put("setting.flood-shield.name", "Force Projectors hold the flood back");
            props.put("setting.flood-strong.name", "Strong flood (scrap walls slowly become thorium walls)");
            props.put("setting.flood-ground.name", "Flood damages ground machines next to it");
            props.put("setting.flood-yellow.name", "New players start on yellow (your own team switch is kept)");
            props.put("setting.flood-antiair.name", "Flood damages flying units");
            props.put("setting.flood-airplayer.name", "...including the player's own unit");
            props.put("setting.flood-infect.name", "Dying crawlers plant flood");
            props.put("setting.flood-autoseed.name", "Plant seeds automatically");
            props.put("setting.flood-campaign.name", "Run in campaign sectors");
            props.put("setting.flood-cheap.name", "Cheap re-place (less lag, no regeneration reset)");
            props.put("setting.flood-delay.name", "Seed delay after start");
            props.put("setting.flood-seeds.name", "Seeds planted per flood");
            props.put("setting.flood-speed.name", "Flood speed");
            var page = guarded("settings page", function(table){
                table.checkPref("flood-enabled", true);
                table.checkPref("flood-red", true);
                table.checkPref("flood-blue", true);
                table.checkPref("flood-green", false);
                table.checkPref("flood-purple", false);
                table.checkPref("flood-shield", true);
                table.checkPref("flood-strong", true);
                table.checkPref("flood-ground", true);
                table.checkPref("flood-corewar", false);
                table.checkPref("flood-yellow", true);
                table.checkPref("flood-antiair", true);
                table.checkPref("flood-airplayer", true);
                table.checkPref("flood-infect", true);
                table.checkPref("flood-autoseed", true);
                table.checkPref("flood-campaign", false);
                table.checkPref("flood-cheap", false);
                table.sliderPref("flood-delay", 60, 0, 600, 10, guarded("slider label", function(i){ return i + " s"; }));
                table.sliderPref("flood-seeds", 3, 1, 20, 1, guarded("slider label", function(i){ return String(i); }));
                table.sliderPref("flood-speed", 100, 10, 500, 10, guarded("slider label", function(i){ return i + "%"; }));
            });
            // The category gets the mod's own icon (sprites/flood-icon.png); without one it would show only a name.
            var icon = null;
            try{ icon = Core.atlas.drawable("flood-mod-flood-icon"); }catch(e1){ icon = null; }
            var added = false;
            if(icon != null){
                try{ Vars.ui.settings.addCategory("Flood", icon, page); added = true; }catch(e2){ Log.err("[flood] settings category with icon failed, trying without: " + e2); }
            }
            if(!added) Vars.ui.settings.addCategory("Flood", page);
        }catch(e){
            Log.err("[flood] could not build the settings page: " + e);
        }
    }

    // ---------------------------------------------------------------- hooks
    try{
        Events.run(EventType.Trigger.update, safeUpdate);
        Events.on(EventType.WorldLoadEvent, guarded("world load", function(e){ reset(); }));
        Events.on(EventType.ClientLoadEvent, guarded("client load", function(e){ registerCommands(); buildSettings(); }));
        Events.on(EventType.ServerLoadEvent, guarded("server load", function(e){ registerCommands(); }));
        Events.on(EventType.UnitDestroyEvent, guarded("unit destroy", onUnitDestroy));
        Events.on(EventType.BlockBuildEndEvent, guarded("block built", onBuildEnd));
        Events.on(EventType.PlayerJoin, guarded("player join", onPlayerJoin));
    }catch(e){
        Log.err("[flood] could not register game hooks, mod inactive: " + e);
    }

    // exposed for testing / other scripts
    return {
        CFG: CFG, COST: COST,
        init: init, iterate: iterate, update: update, reset: reset, stats: stats,
        plantSeeds: plantSeeds, infectAt: infectAt, antiAir: antiAir, enforceYellow: enforceYellow, refreshShields: refreshShields,
        shields: function(){ return shields; }, shieldAt: shieldAt, evolve: evolve, stats2: stats,
        floods: function(){ return floods; }, setRng: function(f){ rng = f; }
    };
})();
