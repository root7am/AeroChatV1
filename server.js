const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new sqlite3.Database('./aerochat.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, username TEXT, bio TEXT, avatar TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, name TEXT, icon TEXT, owner_uid TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, server_id TEXT, name TEXT, type TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, server_id TEXT, name TEXT, color TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS user_roles (user_uid TEXT, role_id TEXT, server_id TEXT)");
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const onlineUsers = {}; 

function emitUpdate(serverId) {
    db.all("SELECT * FROM channels WHERE server_id = ?", [serverId], (err, chans) => {
        db.all("SELECT * FROM roles WHERE server_id = ?", [serverId], (err, roles) => {
            db.all("SELECT ur.user_uid, r.id as roleId, r.name as roleName, r.color FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.server_id = ?", [serverId], (err, assigned) => {
                const usersInSrv = {};
                for(let id in onlineUsers) {
                    if(onlineUsers[id].currentServer === serverId) usersInSrv[id] = onlineUsers[id];
                }
                io.to(serverId).emit('update_state', {
                    users: usersInSrv,
                    channels: chans || [],
                    serverRoles: roles || [],
                    rolesMap: assigned || []
                });
            });
        });
    });
}

io.on('connection', (socket) => {
    socket.on('authenticate', (uid) => {
        db.get("SELECT * FROM users WHERE uid = ?", [uid], (err, row) => {
            let user = row || { uid, username: 'User_'+Math.floor(Math.random()*99), bio: 'Fan d\'Aero', avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed='+uid };
            if(!row) db.run("INSERT INTO users VALUES (?,?,?,?)", [user.uid, user.username, user.bio, user.avatar]);
            onlineUsers[socket.id] = { ...user, currentServer: 'global', inVoice: false, socketId: socket.id };
            socket.join('global');
            socket.emit('profile_saved', onlineUsers[socket.id]);
            db.all("SELECT * FROM servers", [], (err, rows) => socket.emit('load_servers', rows));
            emitUpdate('global');
        });
    });

    // --- NOUVEAU : MISE À JOUR DU PROFIL ---
    socket.on('update_profile', (data) => {
        if(!onlineUsers[socket.id]) return;
        const uid = onlineUsers[socket.id].uid;
        db.run("UPDATE users SET username = ?, avatar = ?, bio = ? WHERE uid = ?", [data.username, data.avatar, data.bio, uid], (err) => {
            if(!err) {
                onlineUsers[socket.id].username = data.username;
                onlineUsers[socket.id].avatar = data.avatar;
                onlineUsers[socket.id].bio = data.bio;
                socket.emit('profile_saved', onlineUsers[socket.id]); // Confirme au client
                emitUpdate(onlineUsers[socket.id].currentServer); // Met à jour pour les autres
            }
        });
    });

    socket.on('join_server', (serverId) => {
        if(!onlineUsers[socket.id]) return;
        socket.leave(onlineUsers[socket.id].currentServer);
        onlineUsers[socket.id].currentServer = serverId;
        socket.join(serverId);
        db.get("SELECT owner_uid, name FROM servers WHERE id = ?", [serverId], (err, srv) => {
            socket.emit('server_info', { id: serverId, name: srv ? srv.name : 'Accueil', isOwner: srv && srv.owner_uid === onlineUsers[socket.id].uid });
            emitUpdate(serverId);
        });
    });

    socket.on('create_channel', (d) => {
        db.run("INSERT INTO channels VALUES (?,?,?,?)", ['c_'+Date.now(), onlineUsers[socket.id].currentServer, d.name, d.type], () => emitUpdate(onlineUsers[socket.id].currentServer));
    });

    socket.on('create_role', (d) => {
        db.run("INSERT INTO roles VALUES (?,?,?,?)", ['r_'+Date.now(), onlineUsers[socket.id].currentServer, d.name, d.color], () => emitUpdate(onlineUsers[socket.id].currentServer));
    });

    socket.on('assign_role', (d) => {
        const srvId = onlineUsers[socket.id].currentServer;
        db.run("DELETE FROM user_roles WHERE user_uid = ? AND server_id = ?", [d.targetUid, srvId], () => {
            db.run("INSERT INTO user_roles VALUES (?,?,?)", [d.targetUid, d.roleId, srvId], () => emitUpdate(srvId));
        });
    });

    socket.on('join_voice', (chanId) => {
        if(!onlineUsers[socket.id]) return;
        onlineUsers[socket.id].inVoice = true;
        onlineUsers[socket.id].currentVoiceChan = chanId;
        socket.to(onlineUsers[socket.id].currentServer).emit('user_entered_voice', { socketId: socket.id });
        emitUpdate(onlineUsers[socket.id].currentServer);
    });

    socket.on('leave_voice', () => {
        if(!onlineUsers[socket.id]) return;
        onlineUsers[socket.id].inVoice = false;
        onlineUsers[socket.id].currentVoiceChan = null;
        emitUpdate(onlineUsers[socket.id].currentServer);
    });

    socket.on('webrtc_signal', (data) => io.to(data.to).emit('webrtc_signal', { from: socket.id, signal: data.signal }));

    socket.on('send_message', (t) => {
        const u = onlineUsers[socket.id];
        db.get("SELECT r.color FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_uid = ? AND ur.server_id = ?", [u.uid, u.currentServer], (err, role) => {
            io.to(u.currentServer).emit('receive_message', { senderId: socket.id, sender: u.username, avatar: u.avatar, text: t, color: role ? role.color : '#0078d7' });
        });
    });

    socket.on('create_server', (d) => {
        const id = 's_'+Date.now();
        db.run("INSERT INTO servers VALUES (?,?,?,?)", [id, d.name, d.icon, onlineUsers[socket.id].uid], () => {
            db.run("INSERT INTO channels VALUES (?,?,?,?)", ['c_'+Date.now(), id, 'général', 'text'], () => {
                db.all("SELECT * FROM servers", [], (err, rows) => io.emit('load_servers', rows));
            });
        });
    });

    socket.on('disconnect', () => { 
        if(onlineUsers[socket.id]) {
            const s = onlineUsers[socket.id].currentServer;
            delete onlineUsers[socket.id];
            emitUpdate(s);
        }
    });
});
server.listen(3000);