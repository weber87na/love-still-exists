// 取得 DOM 元素
const videoElement = document.getElementById('input_video');
const containerBg = document.getElementById('three-bg-container');
const containerFg = document.getElementById('three-fg-container');
const crosshair = document.getElementById('crosshair');
const instructions = document.getElementById('instructions');
const mvVideo = document.getElementById('mv_video');
const vinylRecord = document.getElementById('vinyl-record');

// 遊戲狀態
let isGameStarted = false;
let lastShootTime = 0;
const SHOOT_COOLDOWN = 300; // 開火冷卻時間 (毫秒)
let isThumbCocked = false; // 判斷板機是否已就位 (大拇指翹起)
let hasStartedVideo = false; // 記錄是否已經觸發過第一次播放

// Three.js 變數
let sceneBg, sceneFg, camera, rendererBg, rendererFg, raycaster;
const particles = [];
const petalTextures = [];

// 背景視差變數
let bgPlane, bgMaterial;
let bgTexture = null;
let bgDepthTexture = null;
const cursor = { x: 0, y: 0, lerpX: 0, lerpY: 0 };
const settings = { xThreshold: 40, yThreshold: 60, showWebcam: false, showCrosshair: false, showMV: false, spawnX: 0.6, spawnY: 0.55 };
let gui = null;

// 最新的人臉位置
let latestFaceCenter = null;

// 初始化 Three.js
function initThreeJS() {
    sceneBg = new THREE.Scene();
    sceneFg = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    rendererBg = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    rendererBg.setSize(window.innerWidth, window.innerHeight);
    containerBg.appendChild(rendererBg.domElement);

    rendererFg = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    rendererFg.setSize(window.innerWidth, window.innerHeight);
    containerFg.appendChild(rendererFg.domElement);

    raycaster = new THREE.Raycaster();

    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(0, 1, 1).normalize();
    sceneBg.add(light.clone());
    sceneFg.add(light);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    sceneBg.add(ambientLight.clone());
    sceneFg.add(ambientLight);

    window.addEventListener('resize', onWindowResize, false);
    
    // 加入滑鼠監聽器作為視差效果的備案
    window.addEventListener('mousemove', (event) => {
        cursor.x = event.clientX / window.innerWidth - 0.5;
        cursor.y = event.clientY / window.innerHeight - 0.5;
    });

    loadPetalTextures();
    
    // 載入背景圖與深度圖並產生視差 Plane
    const texLoader = new THREE.TextureLoader();
    let loadedCount = 0;
    const checkLoaded = () => {
        loadedCount++;
        if (loadedCount === 2) {
            createBackgroundPlane();
            initGUI();
            // 直接啟動動畫迴圈，不再等待手勢出現
            startGameLoop();
        }
    };
    bgTexture = texLoader.load('沒扣板機.png', checkLoaded);
    bgDepthTexture = texLoader.load('沒扣板機_depth.png', checkLoaded);
}

function initGUI() {
    if (!gui && typeof dat !== 'undefined') {
        gui = new dat.GUI({ autoPlace: false });
        
        // 手動將 GUI 加入 game-container 並設定極高的 z-index 以防被覆蓋
        const guiContainer = document.createElement('div');
        guiContainer.style.position = 'absolute';
        guiContainer.style.top = '0';
        guiContainer.style.right = '0';
        guiContainer.style.zIndex = '9999';
        guiContainer.appendChild(gui.domElement);
        document.getElementById('game-container').appendChild(guiContainer);

        gui.add(settings, 'xThreshold').min(1).max(100).step(1).name('X 軸位移閾值').onChange(() => {
            if (bgMaterial) bgMaterial.uniforms.uThreshold.value.x = settings.xThreshold;
        });
        gui.add(settings, 'yThreshold').min(1).max(100).step(1).name('Y 軸位移閾值').onChange(() => {
            if (bgMaterial) bgMaterial.uniforms.uThreshold.value.y = settings.yThreshold;
        });
        
        gui.add(settings, 'showWebcam').name('顯示視訊畫面').onChange(() => {
            videoElement.style.opacity = settings.showWebcam ? '0.8' : '0';
        });
        
        gui.add(settings, 'showCrosshair').name('顯示準心').onChange(() => {
            if (!settings.showCrosshair) crosshair.style.display = 'none';
        });

        gui.add(settings, 'showMV').name('顯示 MV 影片').onChange(() => {
            if (mvVideo) mvVideo.style.display = settings.showMV ? 'block' : 'none';
        });
        
        // 套用預設視訊與影片畫面狀態
        videoElement.style.opacity = settings.showWebcam ? '0.8' : '0';
        if (mvVideo) mvVideo.style.display = settings.showMV ? 'block' : 'none';

        // 加入花瓣噴發位置的微調控制
        gui.add(settings, 'spawnX').min(0).max(1).step(0.01).name('花瓣起點 X (左右)');
        gui.add(settings, 'spawnY').min(0).max(1).step(0.01).name('花瓣起點 Y (上下)');
        
        gui.close(); // 預設關閉面板
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    rendererBg.setSize(window.innerWidth, window.innerHeight);
    rendererFg.setSize(window.innerWidth, window.innerHeight);
    updateBackgroundScale();
}

// 計算相機可視範圍大小
function getVisibleSize(depth) {
    const vFOV = camera.fov * Math.PI / 180;
    const height = 2 * Math.tan(vFOV / 2) * Math.abs(camera.position.z - depth);
    const width = height * camera.aspect;
    return { width, height };
}

// 更新背景大小以達到 object-fit: cover 效果
function updateBackgroundScale() {
    if (!bgPlane || !bgTexture) return;
    const size = getVisibleSize(bgPlane.position.z);
    const imageAspect = bgTexture.image.width / bgTexture.image.height;
    const screenAspect = size.width / size.height;
    
    if (screenAspect > imageAspect) {
        bgPlane.scale.set(size.width, size.width / imageAspect, 1);
    } else {
        bgPlane.scale.set(size.height * imageAspect, size.height, 1);
    }
}

function createBackgroundPlane() {
    const planeGeometry = new THREE.PlaneBufferGeometry(1, 1);
    bgMaterial = new THREE.ShaderMaterial({
        uniforms: {
            originalTexture: { value: bgTexture },
            depthTexture: { value: bgDepthTexture },
            uMouse: { value: new THREE.Vector2(0, 0) },
            uThreshold: { value: new THREE.Vector2(settings.xThreshold, settings.yThreshold) },
        },
        fragmentShader: `
            precision mediump float;
            uniform sampler2D originalTexture;
            uniform sampler2D depthTexture;
            uniform vec2 uMouse;
            uniform vec2 uThreshold;
            varying vec2 vUv;

            vec2 mirrored(vec2 v) {
                vec2 m = mod(v, 2.0);
                return mix(m, 2.0 - m, step(1.0, m));
            }

            void main() {
                vec4 depthColor = texture2D(depthTexture, mirrored(vUv));
                // 使用真實的深度圖，讀取紅色通道做為深度
                float depth = depthColor.r;
                
                vec2 fake3d = vec2(
                    vUv.x + (depth - 0.5) * uMouse.x / uThreshold.x,
                    vUv.y + (depth - 0.5) * uMouse.y / uThreshold.y
                );
                gl_FragColor = texture2D(originalTexture, mirrored(fake3d));
            }
        `,
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        depthWrite: false
    });

    bgPlane = new THREE.Mesh(planeGeometry, bgMaterial);
    // 放在花瓣後方 (花瓣會在 z=0 產生，相機在 z=5)
    bgPlane.position.z = -2;
    bgPlane.renderOrder = -1;
    sceneBg.add(bgPlane);
    
    updateBackgroundScale();
}

// 載入花瓣材質
function loadPetalTextures() {
    const textureLoader = new THREE.TextureLoader();
    const petalFiles = [
        'petal/red-petal-01-01.png', 'petal/red-petal-01-05.png', 'petal/red-petal-01-10.png',
        'petal/red-petal-02-01.png', 'petal/red-petal-02-10.png', 'petal/red-petal-02-20.png',
        'petal/red-petal-03-01.png', 'petal/red-petal-03-10.png', 'petal/red-petal-03-20.png',
        'petal/red-petal-04-01.png', 'petal/red-petal-04-10.png', 'petal/red-petal-04-20.png',
        'petal/red-petal-05-01.png', 'petal/red-petal-05-10.png', 'petal/red-petal-05-20.png'
    ];
    
    petalFiles.forEach(file => {
        petalTextures.push(textureLoader.load(file));
    });
}

// 輔助函式：計算兩點距離
function getDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

// 輔助函式：判斷手指是否伸直 (比較指尖與根部 MCP 到手腕的距離，這樣判定比較寬鬆)
function isFingerExtended(landmarks, tipIdx, mcpIdx) {
    const wrist = landmarks[0];
    const tip = landmarks[tipIdx];
    const mcp = landmarks[mcpIdx];
    return getDistance(wrist, tip) > getDistance(wrist, mcp);
}

// 初始化 MediaPipe
function initMediaPipe() {
    // 取消人臉偵測，改由固定圖片位置噴發

    // 2. 初始化手部追蹤
    const hands = new Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});
    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7
    });

    hands.onResults((results) => {
        if (!isGameStarted && results.multiHandLandmarks.length > 0) {
            isGameStarted = true;
            instructions.style.opacity = '0';
            setTimeout(() => instructions.style.display = 'none', 500);
        }

        if (results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            
            // 判斷是否為「手槍」手勢：只要食指與中指有伸直的趨勢就算數，不嚴格檢查其他手指
            const indexExtended = isFingerExtended(landmarks, 8, 5);
            const middleExtended = isFingerExtended(landmarks, 12, 9);
            
            const isGun = indexExtended && middleExtended;
            
            // 抓取食指與中指的根部 (MCP) 作為槍管基準位置
            const indexMcp = landmarks[5];
            const middleMcp = landmarks[9];
            
            // 抓取大拇指指尖，用來判斷是否扣板機
            const thumbTip = landmarks[4];
            // 計算手掌長度 (手腕到食指根部) 作為基準，這段距離不受手指彎曲或遮擋影響
            const handLength = getDistance(landmarks[0], landmarks[5]);
            const thumbDistance = getDistance(thumbTip, indexMcp);
            const relativeThumbDistance = thumbDistance / handLength;

            // 準星位置 (鏡像翻轉 X 軸)
            const targetX = 1 - ((indexMcp.x + middleMcp.x) / 2);
            const targetY = (indexMcp.y + middleMcp.y) / 2;
            
            // 更新視差游標
            cursor.x = targetX - 0.5;
            cursor.y = targetY - 0.5;
            
            if (settings.showCrosshair) {
                crosshair.style.display = 'block';
                crosshair.style.left = `${targetX * 100}vw`;
                crosshair.style.top = `${targetY * 100}vh`;
            } else {
                crosshair.style.display = 'none';
            }

            // 狀態機：判斷是否上膛 (大拇指翹起)
            // 稍微放寬閾值，大於 0.5 視為上膛，小於 0.35 視為扣板機 (容錯率更高)
            const THUMB_COCKED_THRESHOLD = 0.5; 
            const THUMB_FIRE_THRESHOLD = 0.35; 

            if (isGun && relativeThumbDistance > THUMB_COCKED_THRESHOLD) {
                isThumbCocked = true; 
            }

            // 移除「如果不是手槍就取消上膛」的嚴格限制，因為扣板機的瞬間很容易讓食指稍微彎曲導致被判定不是手槍

            const now = Date.now();
            // 放寬擊發條件：只要上膛過，並且大拇指壓下，就觸發開槍
            if (isThumbCocked && relativeThumbDistance < THUMB_FIRE_THRESHOLD && (now - lastShootTime) > SHOOT_COOLDOWN) {
                
                // 讀取設定面板中的花瓣起點座標
                let spawnX = settings.spawnX;
                let spawnY = settings.spawnY;
                let sprayDirX = -1; // 向左噴發

                shoot(spawnX, spawnY, sprayDirX);
                
                // 播放 MV (僅限第一次開槍)
                if (mvVideo && !hasStartedVideo) {
                    mvVideo.currentTime = 0;
                    mvVideo.play();
                    hasStartedVideo = true;
                }
                
                lastShootTime = now;
                isThumbCocked = false; 
            }
        } else {
            crosshair.style.display = 'none';
        }
    });

    const cameraInstance = new Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 640,
        height: 480
    });
    cameraInstance.start();
}

function shoot(screenX, screenY, sprayDirX) {
    // 轉換為 3D 空間座標
    const mouseVector = new THREE.Vector3(
        (screenX * 2) - 1,
        -(screenY * 2) + 1,
        0.5
    );
    mouseVector.unproject(camera);
    const dir = mouseVector.sub(camera.position).normalize();
    const distance = -camera.position.z / dir.z;
    const pos = camera.position.clone().add(dir.multiplyScalar(distance));

    // 產生花瓣 (花雨效果)
    const count = 100 + Math.random() * 50; // 增加花瓣數量
    for(let i=0; i<count; i++) {
        const tex = petalTextures[Math.floor(Math.random() * petalTextures.length)];
        const material = new THREE.MeshBasicMaterial({ 
            map: tex, 
            transparent: true, 
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const geometry = new THREE.PlaneGeometry(0.3, 0.3);
        const petal = new THREE.Mesh(geometry, material);
        
        const scale = 0.5 + Math.random() * 1.2; // 更大的大小差異
        petal.scale.set(scale, scale, 1);
        
        // 讓花瓣在一定範圍內隨機產生，營造充滿空間的花雨感
        petal.position.set(
            pos.x + (Math.random() - 0.5) * 3,
            pos.y + (Math.random() - 0.5) * 2,
            pos.z + (Math.random() - 0.5) * 2
        );
        
        // 給予向四面八方散開的速度
        let vx = (Math.random() - 0.5) * 0.5;
        let vy = Math.random() * 0.4 + 0.1; // 稍微往上噴發
        let vz = (Math.random() - 0.5) * 0.5;
        
        // 如果有偵測到方向，稍微給一個基礎推力
        if (sprayDirX !== 0) {
            vx += sprayDirX * 0.2;
        }
        
        petal.userData = {
            velocity: new THREE.Vector3(vx, vy, vz),
            rotSpeed: new THREE.Vector3((Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2),
            life: 1.0 + Math.random() * 1.5, // 生命週期更長
            seed: Math.random() * Math.PI * 2, // 隨機飄動的種子
            time: 0
        };
        
        sceneFg.add(petal);
        particles.push(petal);
    }
}

// 遊戲主迴圈
function startGameLoop() {
    const clock = new THREE.Clock();
    let previousTime = clock.getElapsedTime();
    
    function animate() {
        requestAnimationFrame(animate);

        const elapsedTime = clock.getElapsedTime();
        const deltaTime = elapsedTime - previousTime;
        previousTime = elapsedTime;

        // 更新背景視差
        if (bgMaterial) {
            const parallaxX = cursor.x * 0.5;
            const parallaxY = -cursor.y * 0.5;
            cursor.lerpX += (parallaxX - cursor.lerpX) * 5 * deltaTime;
            cursor.lerpY += (parallaxY - cursor.lerpY) * 5 * deltaTime;
            bgMaterial.uniforms.uMouse.value.set(cursor.lerpX, cursor.lerpY);
        }

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            
            // 增加時間，用於計算飄動
            p.userData.time += deltaTime;
            
            // 讓花瓣有左右飄動感 (花雨特徵)
            p.position.x += Math.sin(p.userData.time * 2 + p.userData.seed) * 0.01;

            p.position.add(p.userData.velocity);
            
            // 受到重力與空氣阻力影響，讓花瓣更優雅地飄落
            p.userData.velocity.y -= 0.0015; // 重力減弱，延長滯空
            p.userData.velocity.x *= 0.95; // 水平空氣阻力增加 (很快慢下來)
            p.userData.velocity.y *= 0.98; // 垂直空氣阻力
            p.userData.velocity.z *= 0.95;
            
            p.rotation.x += p.userData.rotSpeed.x;
            p.rotation.y += p.userData.rotSpeed.y;
            p.rotation.z += p.userData.rotSpeed.z;
            
            p.material.opacity = Math.min(p.userData.life, 1.0); // 確保一開始是完全不透明
            p.userData.life -= 0.002; // 消失速度變慢，在空間中停留更久
            
            if (p.userData.life <= 0) {
                sceneFg.remove(p);
                p.material.dispose();
                p.geometry.dispose();
                particles.splice(i, 1);
            }
        }

        rendererBg.render(sceneBg, camera);
        rendererFg.render(sceneFg, camera);
    }
    animate();
}

// 啟動
window.onload = () => {
    initThreeJS();
    initMediaPipe();

    // 監聽 MV 影片狀態，控制黑膠唱片轉動
    if (mvVideo && vinylRecord) {
        mvVideo.addEventListener('play', () => {
            vinylRecord.classList.add('playing');
        });
        mvVideo.addEventListener('pause', () => {
            vinylRecord.classList.remove('playing');
        });
        mvVideo.addEventListener('ended', () => {
            vinylRecord.classList.remove('playing');
        });

        // 點擊黑膠唱片控制播放/暫停
        vinylRecord.addEventListener('click', () => {
            if (mvVideo.paused) {
                mvVideo.play();
                hasStartedVideo = true; // 點擊播放也算觸發了第一次
            } else {
                mvVideo.pause();
            }
        });
    }
};
