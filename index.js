const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');

require("dotenv").config();

const app = express();
var dbConnection = null;

const port = process.env.PORT || 8080;
const secretKey = process.env.PATREON_SECRET_KEY || "";
const accessTokenKey = process.env.PATREON_ACCESS_TOKEN_KEY || "";

app.get('/', (req, res) => {
    res.sendStatus(200);
});

app.use('/bridge', bodyParser.raw({type: "*/*"}));
app.use(bodyParser.json({type: 'application/json'}));

// Tries to fetch a pledge by its pledge_id
// from the patreon api

app.get('/fetch_pledge_by_id', async (req, res) => {
    const p = decodeURIComponent(req.query.p);

    if (!p || p.length <= 0) {
        res.sendStatus(401);
        return;
    }

    const _url = `https://www.patreon.com/api/oauth2/v2/members/${p}?include=user,currently_entitled_tiers&fields%5Bmember%5D=campaign_lifetime_support_cents,currently_entitled_amount_cents,email,full_name,is_follower,last_charge_date,last_charge_status,lifetime_support_cents,next_charge_date,note,patron_status,pledge_cadence,pledge_relationship_start,will_pay_amount_cents&fields%5Buser%5D=social_connections`;
    const result = await(await fetch(_url, {
        headers: {
            'Authorization': 'Bearer ' + accessTokenKey
        }
    })).json();

    res.send(result);
});

// Tries to fetch the pledge_id by the discord user_id
// If the user_id exists in the database, it is returned as it is
// Otherwise, it is fetched from patreon api (user must have connected the account)
// If it is found, it is stored in database for future use

// response:
// {
//     "pledge_id": "aaabbbccc"
// }

app.get('/fetch_pledge_by_discord_id', async (req, res) => {
    const u = decodeURIComponent(req.query.u);

    if (!u || u.length <= 0) {
        res.sendStatus(401);
        return;
    }

    try {
        let [ result ] = await dbConnection.execute("SELECT pledge_id FROM premium WHERE discord_userid = ? LIMIT 1", [u]);

        if (result.length > 0) {
            res.send({
                "pledge_id": result[0]["pledge_id"]
            });
            return;
        } else {
            [ result ] = await dbConnection.execute("SELECT pledge_id FROM premium WHERE is_active = 0 AND discord_userid != ?", [u]);

            for (let i = 0; i < result.length; i++) {
                let p = result[i]["pledge_id"];
                const _url = `https://www.patreon.com/api/oauth2/v2/members/${p}?include=user&fields%5Buser%5D=social_connections`;
                const _result = await(await fetch(_url, {
                    headers: {
                        'Authorization': 'Bearer ' + accessTokenKey
                    }
                })).json();
    
                const connections = _result.included[0].attributes;
    
                if (connections && connections.social_connections && connections.social_connections.discord) {
                    if (connections.social_connections.discord.user_id == u) {
                        dbConnection.execute(`UPDATE premium SET discord_userid = ? WHERE pledge_id = ?`, [connections.social_connections.discord.user_id, _result.data.id]);
                        res.send({
                            "pledge_id": _result.data.id
                        });
                        return;
                    }
                }
            }
        }

        res.sendStatus(404);
    } catch (e) {
        console.log(">> [error /fetch_pledge_by_discord_id] " + e);
        res.sendStatus(500);
    }
})

app.post('/bridge', (req, res) => {
    const signature = req.header("X-Patreon-Signature");

    if (!signature) {
        res.sendStatus(403);
        return;
    }

    const hash = crypto.createHmac("md5", secretKey).update(req.body).digest("hex");

    if (hash != signature) {
        res.sendStatus(403);
        return;
    }

    const body = JSON.parse(req.body.toString());

    const isPledgeCreated = !!body.data.id;

    if (isPledgeCreated) {
        
        // Handle when a new pledge is received
        // We fetcth the pledge and user data 
        // and store everything in database
        // (User will need to activate the premium manually)

        pledge_created_handle(body);
    }

    res.sendStatus(200);
});

function pledge_created_handle(pledgeBody) {
    const pledgeData = pledgeBody.data;

    const pledgeId = pledgeData.id;
    let userEmail = pledgeData.attributes ? pledgeData.attributes.email : "";
    const userFullname = pledgeData.attributes ? pledgeData.attributes.full_name : "";
    let nextChargeDate = pledgeData.attributes ? Date.parse(pledgeData.attributes.next_charge_date) : 0;
    let joinedDate = pledgeData.attributes ? Date.parse(pledgeData.attributes.pledge_relationship_start) : 0;

    const userData = pledgeBody.included[1];

    const userId = userData.id;
    let userCreatedDate = userData.attributes ? Date.parse(userData.attributes.created) : 0;
    const discordId = userData.attributes ? (userData.attributes.social_connections ? (userData.attributes.social_connections.discord ? userData.attributes.social_connections.discord.user_id : "") : "") : "";

    // Parse dates for mysql
    // Remove last 3 characters to parse to seconds

    nextChargeDate = nextChargeDate > 0 ? parseInt((nextChargeDate.toString()).slice(0, -3)) : 0;
    joinedDate = joinedDate > 0 ? parseInt((joinedDate.toString()).slice(0, -3)) : 0;
    userCreatedDate = userCreatedDate > 0 ? parseInt((userCreatedDate.toString()).slice(0, -3)) : 0;

    // Try to fetch variables if they fail the first time

    if (!userEmail || userEmail.length <= 0) {
        userEmail = userData.attributes ? userData.attributes.email : "";
    }

    // Store in database the patreon details

    if (dbConnection !== null) {
        try {
            console.log(">> received pledge " + pledgeId);
            console.log(">> trying to insert pledge data to database");

            dbConnection.execute(`INSERT INTO premium(pledge_id, user_full_name, email, patreon_userid, discord_userid, purchased_at, next_charge_date, user_created_date) VALUES('${pledgeId}', '${userFullname}', '${userEmail}', '${userId}', '${discordId && discordId.length > 0 ? discordId : null}', '${joinedDate}', '${userCreatedDate}', '${nextChargeDate}')`);
        } catch (e) {
            console.log(">> error on inserting pledge data to database: " + e);
        }
    } else {
        console.log(">> aborted pledge_created_handle due to database connection being null");
    }
}

(async () => {

    // Open database connection
    // If it fails, we abort start up

    dbConnection = await mysql.createPool({
        host: process.env.MYSQL_HOST || "",
        port: process.env.MYSQL_PORT || "",
        user: process.env.MYSQL_USER || "",
        database: process.env.MYSQL_DB || "",
        password: process.env.MYSQL_PWD || "",
        waitForConnections: true,
        queueLimit: 10
    });

    try {
        await dbConnection.execute("SELECT 1;");

        // Everything is fine (no exception thrown)
        // Start up http interface

        console.log(">> successfully connected to database");
        app.listen(port, () => {
            console.log(">> rbpwh started at port " + port);
        });
    } catch (e) {
        console.log(">> error on database connection, aborting start up: " + e);
    }
})();