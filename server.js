const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose'); // On change sqlite3 pour mongoose

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- CONNEXION MONGODB ---
// REMPLACE BIEN CE LIEN PAR LE TIEN (celui avec admin:root...)
const MONGO_URI = "mongodb+srv://admin:root@aerochat.aklpqjz.mongodb.net/aerochat?retryWrites=true&w=majority&appName=AeroChat";

mongoose.connect(MONGO_URI)
    .then(() => console.log("🍃 Connecté à MongoDB Atlas !"))
    .catch(err => console.error("❌ Erreur de connexion Mongo:", err));

// --- SCHÉMAS DE DONNÉES ---
const User = mongoose.model('User', { uid: String, username: String, bio: String, avatar: String });
const Srv = mongoose.model('Server', { id: String, name: String, icon: String, owner_uid: String });
const Channel = mongoose.model('Channel', { id: String, server_id: String, name: String, type: String });
const Role = mongoose.model('Role', { id: String, server_id: String, name: String, color: String });
const UserRole = mongoose.model('UserRole', { user_uid: String, role_id: String, server_id: String });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const onlineUsers = {}; 

async function emitUpdate(serverId) {
    const chans = await Channel.find({ server_id: serverId });
    const roles = await Role.find({ server_id: serverId });
    const assigned = await UserRole.find({ server_id: serverId });
    
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
}

io.on('connection', (socket) => {
    socket.on('authenticate', async (uid) => {
        let user = await User.findOne({ uid: uid });
        if(!user) {
            user = new User({ 
                uid, 
                username: 'User_'+Math.floor(Math.random()*99), 
                bio: 'Fan d\'Aero', 
                avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed='+uid 
            });
            await user.save();
        }
        
        onlineUsers[socket.id] = { ...user._doc, currentServer: 'global', currentChannel: 'global_chat', inVoice: false, socketId: socket.id };
        socket.join('global');
        socket.emit('profile_saved', onlineUsers[socket.id]);
        
        const servers = await Srv.find();
        socket.emit('load_servers', servers);
        emitUpdate('global');
    });

    socket.on('update_profile', async (data) => {
        if(!onlineUsers[socket.id]) return;
        const uid = onlineUsers[socket.id].uid;
        await User.updateOne({ uid: uid }, { username: data.username, avatar: data.avatar, bio: data.bio });
        
        onlineUsers[socket.id].username = data.username;
        onlineUsers[socket.id].avatar = data.avatar;
        onlineUsers[socket.id].bio = data.bio;
        
        socket.emit('profile_saved', onlineUsers[socket.id]);
        emitUpdate(onlineUsers[socket.id].currentServer);
    });

    socket.on('join_server', async (serverId) => {
        if(!onlineUsers[socket.id]) return;
        socket.leave(onlineUsers[socket.id].currentServer);
        onlineUsers[socket.id].currentServer = serverId;
        socket.join(serverId);
        
        const srv = await Srv.findOne({ id: serverId });
        socket.emit('server_info', { 
            id: serverId, 
            name: srv ? srv.name : 'Accueil', 
            isOwner: srv && srv.owner_uid === onlineUsers[socket.id].uid 
        });
        emitUpdate(serverId);
    });

    socket.on('create_channel', async (d) => {
        const srvId = onlineUsers[socket.id].currentServer;
        const newChan = new Channel({ id: 'c_'+Date.now(), server_id: srvId, name: d.name, type: d.type });
        await newChan.save();
        emitUpdate(srvId);
    });

    socket.on('create_role', async (d) => {
        const srvId = onlineUsers[socket.id].currentServer;
        const newRole = new Role({ id: 'r_'+Date.now(), server_id: srvId, name: d.name, color: d.color });
        await newRole.save();
        emitUpdate(srvId);
    });

    socket.on('assign_role', async (d) => {
        const srvId = onlineUsers[socket.id].currentServer;
        await UserRole.deleteOne({ user_uid: d.targetUid, server_id: srvId });
        const newUR = new UserRole({ user_uid: d.targetUid, role_id: d.roleId, server_id: srvId });
        await newUR.save();
        emitUpdate(srvId);
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

    socket.on('send_message', async (t) => {
        const u = onlineUsers[socket.id];
        if(!u) return;
        const roleLink = await UserRole.findOne({ user_uid: u.uid, server_id: u.currentServer });
        let color = '#0078d7';
        if(roleLink) {
            const role = await Role.findOne({ id: roleLink.role_id });
            if(role) color = role.color;
        }
        io.to(u.currentServer).emit('receive_message', { senderId: socket.id, sender: u.username, avatar: u.avatar, text: t, color });
    });

    socket.on('create_server', async (d) => {
        const id = 's_'+Date.now();
        const newSrv = new Srv({ id, name: d.name, icon: d.icon, owner_uid: onlineUsers[socket.id].uid });
        await newSrv.save();
        const firstChan = new Channel({ id: 'c_'+Date.now(), server_id: id, name: 'général', type: 'text' });
        await firstChan.save();
        
        const servers = await Srv.find();
        io.emit('load_servers', servers);
    });

    socket.on('disconnect', () => { 
        if(onlineUsers[socket.id]) {
            const s = onlineUsers[socket.id].currentServer;
            delete onlineUsers[socket.id];
            emitUpdate(s);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 AeroChat Cloud sur le port ${PORT}`));